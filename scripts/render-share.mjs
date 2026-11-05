/**
 * Render a profile's social preview image (1200 × 630) from design/share.html and a capture of the live map.
 * Needs a built and served atlas (npm run build && npm run preview) and Playwright with Chromium.
 *
 *   node scripts/render-share.mjs --profile profiles/offchain-media --url http://127.0.0.1:8790/community-atlas/
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/io.mjs";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "profiles/offchain-media" },
    url: { type: "string", default: "http://127.0.0.1:8790/community-atlas/" },
  },
});
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const design = resolve(ROOT, values.profile, "design");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

// 1. The map at world zoom, without the interface.
const embed = new URL("embed/?view=map&theme=light&lat=22&lon=-98&z=1.5", values.url);
await page.goto(embed.href, { waitUntil: "load" });
await page.addStyleTag({ content: ".top,.map-panel,.maplibregl-control-container{display:none!important}#view-map{height:100vh!important}" });
await page.waitForTimeout(7000);
await page.screenshot({ path: join(design, "map.png") });

// 2. The card.
await page.goto(pathToFileURL(join(design, "share.html")).href, { waitUntil: "load" });
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(ROOT, values.profile, "share.png") });
await browser.close();
console.log("Wrote", join(values.profile, "share.png"));
