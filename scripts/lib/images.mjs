/**
 * Images are copied and resized at harvest time, then served by the atlas itself,
 * so visitors never load anything from the sources' servers.
 * Files go to data/images/ (not committed); data/images/index.json remembers the source of each file
 * so an image is fetched again only when its source changes.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { ROOT, fetchBuffer, readJSON, writeJSON } from "./io.mjs";

export const IMAGES = resolve(ROOT, "data/images");
const INDEX = resolve(IMAGES, "index.json");
const SIZES = {
  event: { width: 480, height: 270, fit: "cover" },
  logo: { width: 128, height: 128, fit: "cover" },
};

let index = null;
async function loadIndex() {
  index ??= await readJSON(INDEX, {});
  return index;
}
export async function saveIndex() {
  if (index) await writeJSON(INDEX, Object.fromEntries(Object.entries(index).sort()));
}

/**
 * Store one image. `source` is a URL or a local file path; `name` the path under data/images/ without extension.
 * Returns the stored path (such as "events/planb-x.webp"), or null when the image cannot be read.
 */
export async function storeImage(source, name, kind = "event") {
  const idx = await loadIndex();
  const file = name + ".webp";
  const out = resolve(IMAGES, file);
  if (idx[file] === source && existsSync(out)) return file;
  try {
    const input = /^https?:/.test(source) ? await fetchBuffer(source, { timeout: 20000 }) : await readFile(source);
    const webp = await sharp(input, { animated: false, limitInputPixels: 50e6 })
      .resize({ ...SIZES[kind], withoutEnlargement: false, position: "attention" })
      .webp({ quality: kind === "logo" ? 80 : 72 })
      .toBuffer();
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, webp);
    idx[file] = source;
    return file;
  } catch {
    return null;
  }
}
