// Headless smoke test: boot the game in real Chromium, capture console/page errors,
// verify the WebGL canvas actually drew a recognisable world (sky above, terrain
// below — not a blank/black/sky-only frame), and screenshot it.
//
// Browser resolution (CI-portable):
//   1. CHROME_PATH env  → use that executable (e.g. a system Chrome)
//   2. otherwise        → Playwright's bundled Chromium (`npx playwright install chromium`)
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5191/";

// The sky colour is the single source of truth in src/main.ts (`const SKY = 0x8fbcff`).
// Re-derived here so the render oracle is independent of the screenshot byte size.
const SKY = [0x8f, 0xbc, 0xff]; // 143, 188, 255

const launchArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"];
const launchOpts = { args: launchArgs };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });

const errors = [];
const ignore = (t) => /favicon|404 \(Not Found\)/i.test(t); // missing favicon is harmless
page.on("console", (m) => {
  if (m.type() === "error" && !ignore(m.text())) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(URL, { waitUntil: "networkidle" });
// Wait for the CONDITION, not a fixed sleep: the player spawns a few blocks up and
// falls under gravity (and, at the waterline spawn, sinks the last bit slowed by swim
// buoyancy/drag), so a fixed sleep races the landing on a slow runner and flakily reads
// "air". Poll the HUD until physics has resolved the player onto the ground (which also
// proves the frame loop ran for many frames). The timeout is generous because under
// software-WebGL CI the frame loop is render-bound (few frames/sec), so settling takes
// many wall-clock seconds. If it never lands — a real regression — this times out and the
// onGround check below reports the failure with the usual census output (not a throw).
await page
  .waitForFunction(() => /ground/.test(document.getElementById("hud")?.innerText ?? ""), null, {
    timeout: 30000,
    polling: 100,
  })
  .catch(() => {});
await page.waitForTimeout(250); // brief settle so the screenshot isn't mid-frame

// HUD text proves: boot self-check passed (no throw), terrain generated, the frame
// loop runs, and physics resolved the player onto the ground.
const hud = await page
  .locator("#hud")
  .innerText()
  .catch(() => "");
const hotbarSlots = await page.locator("#hotbar .slot").count();
const hasWebGL = await page.evaluate(() => {
  const c = document.getElementById("app");
  return !!(c.getContext("webgl2") || c.getContext("webgl"));
});

// --- Render oracle ------------------------------------------------------------
// Screenshot the canvas, decode it back to pixels in the browser (the page's PNG
// decoder — no native deps, and it reads the already-composited framebuffer, so it
// is immune to preserveDrawingBuffer=false), then run a pixel census that pins
// three INDEPENDENT facts a genuinely-rendered voxel world must satisfy:
//   (1) terrain FILLS the frame — most pixels are not the sky clear-colour. If the
//       mesher/geometry-upload silently produced nothing, the canvas would clear to
//       SKY and this fraction would collapse to ~0.
//   (2) the frame has real luminance VARIANCE — a blank/flat/lost-context canvas is
//       a single colour (std ~0); a lit 3D scene is not.
//   (3) many DISTINCT colours — a single-colour canvas has ~1.
// At the fixed deterministic spawn the frame is ~64% terrain / ~36% sky; the census
// requires terrain to fill at least half, which fails the moment geometry stops
// drawing (the canvas then clears to 100% sky → nonSkyFraction 0, lumStd 0, 1 colour).
//
// Hide the DOM chrome first. The frame loop renders behind it regardless, but in
// headless there is no user gesture to take pointer-lock, so the start overlay
// (a 60%-black scrim + instructions) stays up — and an element screenshot composites
// whatever overlaps the canvas. Removing the overlay/HUD/hotbar/crosshair leaves a
// pure WebGL framebuffer to census; without this, the scrim darkens the sky into a
// terrain-like tone and the "terrain filled the frame" check can't fail.
await page.evaluate(() => {
  for (const id of ["overlay", "hud", "hotbar", "crosshair"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
});
const canvasPng = await page.locator("#app").screenshot();
const render = await page.evaluate(
  async ({ dataUrl, sky }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const W = img.width,
      H = img.height;
    const px = ctx.getImageData(0, 0, W, H).data;
    const at = (x, y) => {
      const i = (y * W + x) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    };
    const dist = (c) => Math.abs(c[0] - sky[0]) + Math.abs(c[1] - sky[1]) + Math.abs(c[2] - sky[2]);
    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

    const seen = new Set();
    let nonSky = 0,
      total = 0,
      sum = 0,
      sum2 = 0;
    for (let y = 0; y < H; y += 3)
      for (let x = 0; x < W; x += 3) {
        const c = at(x, y);
        total++;
        if (dist(c) > 60) nonSky++; // clearly not the sky clear-colour → drawn geometry
        const L = lum(c);
        sum += L;
        sum2 += L * L;
        seen.add((c[0] >> 4) + "," + (c[1] >> 4) + "," + (c[2] >> 4));
      }
    const mean = sum / total;
    const lumStd = Math.sqrt(Math.max(0, sum2 / total - mean * mean));
    return {
      W,
      H,
      nonSkyFraction: +(nonSky / total).toFixed(3),
      lumMean: +mean.toFixed(1),
      lumStd: +lumStd.toFixed(1),
      distinctColours: seen.size,
    };
  },
  { dataUrl: "data:image/png;base64," + canvasPng.toString("base64"), sky: SKY },
);

// Keep saving a full-page screenshot for the CI artifact / eyeball.
await page.screenshot({ path: "scripts/screenshot.png" });
await browser.close();

console.log("HUD:", JSON.stringify(hud));
console.log("hotbar slots:", hotbarSlots, "| webgl:", hasWebGL);
console.log("RENDER:", JSON.stringify(render));
console.log("CONSOLE/PAGE ERRORS:", errors.length ? errors : "none");

const checks = {
  noErrors: errors.length === 0,
  hudRan: /xyz:/.test(hud),
  onGround: /ground/.test(hud),
  hotbar: hotbarSlots > 0, // the hotbar DOM built (the exact roster is pinned by the blocks oracle)
  webgl: hasWebGL,
  terrainDrawn: render.nonSkyFraction >= 0.5, // world fills the frame; ~0 ⇒ only sky drew (no geometry)
  hasStructure: render.lumStd >= 6, // lit 3D scene varies; a flat/blank canvas has std ~0
  notBlank: render.distinctColours >= 8, // a single-colour canvas has ~1
};
console.log("CHECKS:", JSON.stringify(checks));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "SMOKE: PASS" : "SMOKE: FAIL");
process.exit(pass ? 0 : 1);
