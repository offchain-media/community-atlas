/**
 * Refresh every source named in the profile. A source that fails keeps its previous file,
 * so one unreachable site never empties the atlas.
 *
 *   node scripts/harvest.mjs [--profile profiles/offchain-media] [--only btcmap,meetup,planb,feeds]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, SOURCES, readJSON, setUserAgent, writeJSON } from "./lib/io.mjs";
import { harvestAreas, harvestMerchants } from "./harvest/btcmap.mjs";
import { harvestMeetup } from "./harvest/meetup.mjs";
import { harvestPlanB } from "./harvest/planb.mjs";
import { harvestFeeds } from "./harvest/feeds.mjs";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: process.env.ATLAS_PROFILE || "profiles/offchain-media" },
    only: { type: "string" },
  },
});
const profile = await readJSON(resolve(ROOT, values.profile, "profile.json"));
const only = values.only ? new Set(values.only.split(",")) : null;
const want = (name) => !only || only.has(name);
const s = profile.sources || {};
setUserAgent(profile.repository);

const steps = [
  ["merchants", s.merchants && want("btcmap"), harvestMerchants],
  // Country shapes are always needed: they give every place and community its country.
  ["areas", want("btcmap"), harvestAreas],
  ["meetup", s.meetup && want("meetup"), () => harvestMeetup()],
  ["planb", s.planb && want("planb"), harvestPlanB],
  ["feeds", s.feeds?.length && want("feeds"), () => harvestFeeds(s.feeds)],
];

const metaPath = resolve(SOURCES, "meta.json");
const meta = await readJSON(metaPath, {});
let failed = 0;
for (const [name, enabled, run] of steps) {
  if (!enabled) continue;
  const started = Date.now();
  try {
    const result = await run();
    meta[name] = { ok: true, at: new Date().toISOString(), result };
    console.log(`✓ ${name}`, JSON.stringify(result), `${Date.now() - started} ms`);
  } catch (error) {
    failed++;
    meta[name] = { ...(meta[name] || {}), ok: false, lastError: String(error.message || error), failedAt: new Date().toISOString() };
    console.error(`✗ ${name}: ${error.message || error} (previous data kept)`);
  }
}
await writeJSON(metaPath, meta);
if (failed && process.env.HARVEST_STRICT) process.exit(1);
