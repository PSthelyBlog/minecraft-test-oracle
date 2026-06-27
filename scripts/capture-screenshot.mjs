// One-off hero-screenshot capture for the README (docs/screenshot.png).
//
// Reuses the smoke test's headless-Chromium + software-WebGL setup, but poses the
// frame for a *nice* shot rather than a census: it hides only the start-overlay
// scrim (in headless there is no gesture to take pointer-lock, so the overlay would
// otherwise stay up and darken everything) and KEEPS the HUD, hotbar swatches, and
// crosshair visible — the game as played. The world is the fixed deterministic
// spawn, so the capture is reproducible.
//
// Usage: start a preview server, then run this with URL pointing at it, e.g.
//   npm run preview -- --port 4173 --strictPort &
//   URL=http://localhost:4173/ node scripts/capture-screenshot.mjs
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:4173/";
const OUT = process.env.OUT ?? "docs/screenshot.png";

const launchArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"];
const launchOpts = { args: launchArgs };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

const browser = await chromium.launch(launchOpts);
// deviceScaleFactor 2 → a crisp 2x PNG for the README hero.
const page = await browser.newPage({
  viewport: { width: 1200, height: 750 },
  deviceScaleFactor: 2,
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500); // let a few frames render and physics settle

// Drop only the click-to-play scrim; leave the HUD/hotbar/crosshair so the shot
// shows the textured world the way it looks in-game.
await page.evaluate(() => {
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.style.display = "none";
});

await page.screenshot({ path: OUT });
await browser.close();
console.log("Wrote", OUT);
