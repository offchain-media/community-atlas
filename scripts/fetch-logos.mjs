/**
 * Fetch the logos of the companies in a profile's ecosystem.json, from their GitHub organisation avatar
 * (field "github"), resize them and store them in the profile under logos/. Run by hand, then review and commit.
 *
 *   node scripts/fetch-logos.mjs [--profile profiles/offchain-media]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { ROOT, fetchBuffer, readJSON, writeJSON } from "./lib/io.mjs";

const { values } = parseArgs({ options: { profile: { type: "string", default: process.env.ATLAS_PROFILE || "profiles/offchain-media" } } });
const dir = resolve(ROOT, values.profile);
const file = join(dir, "ecosystem.json");
const data = await readJSON(file);
await mkdir(join(dir, "logos"), { recursive: true });
for (const c of data.companies) {
  if (!c.github) continue;
  const source = `https://avatars.githubusercontent.com/${encodeURIComponent(c.github)}?s=256`;
  try {
    const png = await sharp(await fetchBuffer(source)).resize(128, 128, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
    await writeFile(join(dir, "logos", c.id + ".webp"), png);
    c.logo = "logos/" + c.id + ".webp";
    c.logoSource = `https://github.com/${c.github}`;
    console.log("✓", c.name);
  } catch (error) {
    console.error("✗", c.name, error.message);
  }
}
await writeJSON(file, data);
