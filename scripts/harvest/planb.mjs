/**
 * Plan ₿ Network events, from its open educational content repository (CC BY-SA 4.0).
 * https://github.com/PlanB-Network/bitcoin-educational-content/tree/dev/events
 *
 * Cities are geocoded with OpenStreetMap Nominatim, at most 1 request per second,
 * with results kept in data/geocode-cache.json so each city is looked up once.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { ROOT, SOURCES, fetchJSON, readJSON, sleep, writeJSON } from "../lib/io.mjs";
import { safeURL, safeZone } from "../../src/shared/util.js";
import { saveIndex, storeImage } from "../lib/images.mjs";

const REPO = "https://github.com/PlanB-Network/bitcoin-educational-content";
const BRANCH = "dev";
const CACHE = resolve(ROOT, "data/geocode-cache.json");
const TYPES = { conference: "conference", meetup: "meetup", workshop: "workshop", course: "course", lecture: "workshop" };

function checkout() {
  const dir = process.env.PLANB_CONTENT_DIR || resolve(ROOT, ".cache/planb-content");
  if (existsSync(resolve(dir, "events"))) {
    if (!process.env.PLANB_CONTENT_DIR)
      execFileSync("git", ["-C", dir, "pull", "--ff-only", "-q"], { stdio: "inherit" });
    return dir;
  }
  execFileSync(
    "git",
    ["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "-b", BRANCH, REPO, dir],
    { stdio: "inherit" },
  );
  execFileSync("git", ["-C", dir, "sparse-checkout", "set", "events"], { stdio: "inherit" });
  return dir;
}

async function geocode(query, cache) {
  const key = query.trim().toLowerCase();
  if (key in cache) return cache[key];
  await sleep(1100);
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=en&q=" +
    encodeURIComponent(query);
  const [hit] = await fetchJSON(url, { timeout: 20000 });
  cache[key] = hit
    ? {
        lat: +(+hit.lat).toFixed(4),
        lon: +(+hit.lon).toFixed(4),
        country: hit.address?.country_code?.toUpperCase() || null,
        city:
          hit.address?.city || hit.address?.town || hit.address?.village || hit.address?.state || hit.name || null,
        osm: `${hit.osm_type}/${hit.osm_id}`,
      }
    : null;
  return cache[key];
}

/** Local calendar date and time of an instant in a time zone. */
function localParts(date, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * Plan ₿ stores start_date and end_date in UTC, with the event's time zone alongside.
 * A start at local midnight and an end at local 23:59 (or midnight) means whole days.
 */
export function planbDates(startValue, endValue, timeZone) {
  const parse = (v) => {
    const s = String(v ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { day: s };
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
    return m ? { instant: new Date(`${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}Z`) } : null;
  };
  const a = parse(startValue),
    b = parse(endValue);
  if (!a) return null;
  if (a.day) return { start: a.day, end: b?.day || b?.instant?.toISOString().slice(0, 10) || null, dateOnly: true };
  const zone = timeZone && safeZone(timeZone) === timeZone ? timeZone : null;
  const ls = localParts(a.instant, zone || "UTC");
  const le = b?.instant ? localParts(b.instant, zone || "UTC") : null;
  const wholeDays = ls.time === "00:00" && (!le || le.time === "23:59" || le.time === "00:00");
  if (wholeDays) {
    let endDay = le?.day || null;
    if (le?.time === "00:00" && endDay > ls.day)
      endDay = new Date(Date.parse(endDay + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    return { start: ls.day, end: endDay, dateOnly: true };
  }
  return { start: a.instant.toISOString(), end: b?.instant?.toISOString() || null, dateOnly: false, timeZone: zone };
}

export async function harvestPlanB() {
  const dir = checkout();
  const cache = await readJSON(CACHE, {});
  const folders = (await readdir(resolve(dir, "events"), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const events = [],
    skipped = [],
    notLocated = [];
  for (const folder of folders) {
    let y;
    try {
      y = parse(await readFile(resolve(dir, "events", folder, "event.yml"), "utf8"));
    } catch {
      skipped.push({ folder, reason: "unreadable event.yml" });
      continue;
    }
    if (!y?.name || y.test_only) {
      skipped.push({ folder, reason: "test or unnamed" });
      continue;
    }
    const dates = planbDates(y.start_date, y.end_date, y.timezone || null);
    if (!dates) {
      skipped.push({ folder, reason: "no start date" });
      continue;
    }
    const place = String(y.address_city_country || "").trim();
    const online = !place || /online|virtual|remote/i.test(place);
    let geo = null;
    if (!online) {
      try {
        geo = await geocode(place, cache);
      } catch (error) {
        notLocated.push({ folder, place, error: error.message });
      }
      if (!geo && !notLocated.some((n) => n.folder === folder)) notLocated.push({ folder, place, error: "not found" });
    }
    const listing = y.id ? `https://planb.academy/en/events/${y.id}` : null;
    // Thumbnails of events from the last year onwards; older ones are rarely looked at.
    const thumbnail = resolve(dir, "events", folder, "assets/thumbnail.webp");
    const recent = Date.parse(dates.end || dates.start) > Date.now() - 365 * 86400000;
    const image = recent && existsSync(thumbnail) ? await storeImage(thumbnail, "events/planb-" + folder.replace(/[^\w-]/g, "_")) : null;
    events.push({
      id: "planb:" + folder,
      source: "planb",
      sourceName: "Plan ₿ Network",
      type: TYPES[y.type] || "other",
      status: "confirmed",
      title: String(y.name).trim(),
      start: dates.start,
      end: dates.end,
      dateOnly: dates.dateOnly,
      timeZone: dates.timeZone || null,
      city: geo?.city || place.split(",")[0] || null,
      country: geo?.country || null,
      lon: geo?.lon ?? null,
      lat: geo?.lat ?? null,
      precision: geo ? "city" : null,
      online,
      venue: [y.address_line_2, y.address_line_3].filter(Boolean).join(", ") || null,
      url: safeURL(y.links?.website) || listing,
      image,
      listing,
      attribution: {
        name: "Plan ₿ Network",
        url: `${REPO}/tree/${BRANCH}/events/${encodeURIComponent(folder)}`,
        license: "CC BY-SA 4.0",
      },
    });
  }
  await writeJSON(CACHE, Object.fromEntries(Object.entries(cache).sort()));
  await saveIndex();
  const commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
  await writeJSON(resolve(SOURCES, "planb-events.json"), {
    fetchedAt: new Date().toISOString(),
    source: `${REPO}/tree/${commit}/events`,
    license: "CC BY-SA 4.0 (Plan ₿ Network)",
    skipped,
    notLocated,
    events,
  });
  return { events: events.length, skipped: skipped.length, notLocated: notLocated.length };
}
