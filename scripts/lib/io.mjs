import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SOURCES = resolve(ROOT, "data/sources");
const PKG = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
let userAgent = `CommunityAtlas/${PKG.version}`;

/** Identify requests with the edition's repository, as Nominatim and others ask. */
export function setUserAgent(repository) {
  userAgent = `CommunityAtlas/${PKG.version}${repository ? ` (+${repository})` : ""}`;
}

export async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJSON(path, value, pretty = true) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    (pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value)) + "\n",
  );
}

export async function fetchText(url, { timeout = 30000, headers = {} } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, ...headers },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

export async function fetchJSON(url, options) {
  return JSON.parse(await fetchText(url, options));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with limited concurrency, keeping result order. */
export async function pool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i], i);
      }
    }),
  );
  return results;
}
