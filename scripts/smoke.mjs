// Headless smoke test: boot the game in real Chrome, capture console/page errors,
// verify the WebGL canvas actually drew non-empty frames, and screenshot it.
import { chromium } from "playwright-core";

const URL = process.env.URL ?? "http://localhost:5191/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });

const errors = [];
const ignore = (t) => /favicon|404 \(Not Found\)/i.test(t); // missing favicon is harmless
page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500); // let a few frames render

// HUD text proves: boot self-check passed (no throw), terrain generated, the frame
// loop runs, and physics resolved the player onto the ground.
const hud = await page.locator("#hud").innerText().catch(() => "");
const hotbarSlots = await page.locator("#hotbar .slot").count();
const hasWebGL = await page.evaluate(() => {
  const c = document.getElementById("app");
  return !!(c.getContext("webgl2") || c.getContext("webgl"));
});

// Screenshot is composited from the real framebuffer; a rendered voxel world makes
// a far larger PNG than a blank single-colour canvas (~few KB).
const shot = await page.screenshot({ path: "scripts/screenshot.png" });
await browser.close();

console.log("HUD:", JSON.stringify(hud));
console.log("hotbar slots:", hotbarSlots, "| webgl:", hasWebGL, "| screenshot bytes:", shot.length);
console.log("CONSOLE/PAGE ERRORS:", errors.length ? errors : "none");

const checks = {
  noErrors: errors.length === 0,
  hudRan: /xyz:/.test(hud),
  onGround: /ground/.test(hud),
  hotbar: hotbarSlots === 10,
  webgl: hasWebGL,
  rendered: shot.length > 15000, // blank canvas screenshots are a few KB
};
console.log("CHECKS:", JSON.stringify(checks));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "SMOKE: PASS" : "SMOKE: FAIL");
process.exit(pass ? 0 : 1);
