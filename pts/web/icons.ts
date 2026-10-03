// Renders the PWA icons from pts/assets/logo.png: bun pts/web/icons.ts (needs Playwright's Chromium).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

const LOGO = readFileSync(join(import.meta.dir, "..", "assets", "logo.png")).toString("base64");
const OUT = join(import.meta.dir, "public");

// the banner's ground, so the home-screen icon matches the brand art
const GROUND = "#1F1F1F";

const ICONS = [

  // maskable icons are cropped to a circle by some launchers, so the torch keeps to the middle half
  { file: "icon-192.png", size: 192, scale: 0.6, ground: GROUND },
  { file: "icon-512.png", size: 512, scale: 0.6, ground: GROUND },
  { file: "icon-maskable-512.png", size: 512, scale: 0.5, ground: GROUND },
  { file: "apple-touch-icon.png", size: 180, scale: 0.6, ground: GROUND },
  { file: "logo.png", size: 128, scale: 1, ground: "transparent" },

];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const icon of ICONS) {

  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(`<body style="margin:0;width:${icon.size}px;height:${icon.size}px;display:flex;align-items:center;justify-content:center;background:${icon.ground}"><img src="data:image/png;base64,${LOGO}" style="width:${icon.scale * 100}%;height:${icon.scale * 100}%;object-fit:contain"></body>`);
  await page.screenshot({ path: join(OUT, icon.file), omitBackground: icon.ground === "transparent" });

}

await browser.close();
