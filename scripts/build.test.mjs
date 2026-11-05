// Builds both bundled profiles from the committed source data and checks the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import worker from "../worker.mjs";

const root = resolve(import.meta.dirname, "..");
const out = join(tmpdir(), "atlas-test-" + process.pid);
const build = (profile, dir) =>
  execFileSync("node", ["scripts/build.mjs", "--profile", profile, "--out", dir, "--now", "2026-11-05T12:00:00Z"], { cwd: root }).toString();

test("Off-Chain Media edition builds under its two paths", (t) => {
  const dir = out + "-ocm";
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  build("profiles/offchain-media", dir);
  const en = readFileSync(join(dir, "community-atlas/index.html"), "utf8");
  const fr = readFileSync(join(dir, "fr/community-atlas/index.html"), "utf8");
  assert.match(en, /<html lang="en"/);
  assert.match(fr, /<html lang="fr"/);
  assert.match(en, /rel="canonical" href="https:\/\/offchain.media\/community-atlas\/"/);
  assert.match(fr, /hreflang="en" href="https:\/\/offchain.media\/community-atlas\/"/);
  // Every local asset reference stays under the atlas paths, never the root of offchain.media.
  for (const html of [en, fr])
    for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^"]*)"/g))
      assert.ok(ref.startsWith("/community-atlas/") || ref.startsWith("/fr/community-atlas/"), ref);
  for (const f of ["data/events.json", "data/merchants.json", "data/communities.json", "data/ecosystem.json", "data/meta.json", "data/countries.json", "events.ics", "llms.txt", "sitemap.xml", "assets/app.js", "assets/shared/events.js", "embed/index.html"])
    assert.ok(existsSync(join(dir, "community-atlas", f)), f);
  const events = JSON.parse(readFileSync(join(dir, "community-atlas/data/events.json"), "utf8")).events;
  assert.ok(events.length > 0);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  // Every picture an event or a community points to is in the build (none when nothing was harvested).
  for (const e of events.filter((e) => e.image)) assert.ok(existsSync(join(dir, e.image)), e.image);
  const communities = JSON.parse(readFileSync(join(dir, "community-atlas/data/communities.json"), "utf8")).communities;
  for (const c of communities.filter((c) => c.image)) assert.ok(existsSync(join(dir, c.image)), c.image);
  assert.ok(communities.every((c) => !JSON.stringify(c.links).match(/mailto:|"email"|"phone"|whatsapp/i)), "no personal contact fields");
  const embed = readFileSync(join(dir, "community-atlas/embed/index.html"), "utf8");
  assert.match(embed, /name="robots" content="noindex"/);
  assert.match(en, /"embed":false/);
  assert.match(embed, /"embed":true/);
});

test("a regional profile keeps only its countries", (t) => {
  const dir = out + "-region";
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  build("profiles/example-region", dir);
  const merchants = JSON.parse(readFileSync(join(dir, "data/merchants.json"), "utf8")).places;
  assert.ok(merchants.length > 0);
  assert.ok(merchants.every((p) => ["LT", "LV", "EE"].includes(p[4])), "only Baltic places");
  const events = JSON.parse(readFileSync(join(dir, "data/events.json"), "utf8")).events;
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => ["LT", "LV", "EE"].includes(e.country)), "every event is in a Baltic country");
  assert.ok(existsSync(join(dir, "index.html")));
});

test("the edition's own events use the feed format and win over other sources", (t) => {
  const profileDir = mkdtempSync(join(tmpdir(), "atlas-profile-"));
  const dir = out + "-own";
  t.after(() => {
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  const profile = JSON.parse(readFileSync(join(root, "profiles/example-region/profile.json"), "utf8"));
  profile.shareImage = "share.png";
  writeFileSync(join(profileDir, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(profileDir, "share.png"), "png");
  // Same title and day as an event published in the Lithuania BTC feed.
  const feedEvent = JSON.parse(readFileSync(join(root, "data/sources/feed-events.json"), "utf8")).events.find(
    (e) => e.source === "feed:lithuaniabtc.com" && e.start && Number.isFinite(e.lat),
  );
  writeFileSync(
    join(profileDir, "events.json"),
    JSON.stringify([
      { id: "ours", type: "meetup", title: { en: feedEvent.title, lt: "Mūsų" }, start: feedEvent.start, lat: feedEvent.lat, lon: feedEvent.lon, country: "LT" },
      { id: "next-a", status: "planned", title: { en: "Next walk" }, country: "LT" },
      { id: "next-b", status: "planned", title: { en: "Next meetup" }, country: "LT" },
    ]),
  );
  build(profileDir, dir);
  const events = JSON.parse(readFileSync(join(dir, "data/events.json"), "utf8")).events;
  const ours = events.find((e) => e.id === "curated:ours");
  assert.equal(ours.title, feedEvent.title);
  assert.deepEqual(ours.titles, { en: feedEvent.title, lt: "Mūsų" });
  assert.ok(ours.alsoListedBy.some((o) => o.source === "feed:lithuaniabtc.com"), "the feed copy is merged into ours");
  assert.ok(!events.some((e) => e.id === feedEvent.id));
  assert.equal(events.filter((e) => e.status === "planned" && e.source === "curated").length, 2);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.match(html, /og:image" content="https:\/\/atlas.example.org\/assets\/share.png"/);
  assert.ok(existsSync(join(dir, "assets/share.png")));
});

test("published companies are verified and carry no internal review fields", (t) => {
  const dir = out + "-eco";
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  build("profiles/offchain-media", dir);
  const { companies } = JSON.parse(readFileSync(join(dir, "community-atlas/data/ecosystem.json"), "utf8"));
  const source = JSON.parse(readFileSync(join(root, "profiles/offchain-media/ecosystem.json"), "utf8")).companies;
  assert.equal(companies.length, source.filter((c) => c.verification === "read" || c.review === "approved").length);
  for (const c of companies) for (const k of ["verification", "review", "evidenceNote"]) assert.ok(!(k in c), k);
});

test("worker opens data to other sites and lets only embeds be framed", async () => {
  const env = { ASSETS: { fetch: async () => new Response("x", { headers: { "Content-Type": "text/html" } }) } };
  const get = (p, method = "GET") => worker.fetch(new Request("https://offchain.media" + p, { method }), env);
  assert.equal((await get("/community-atlas/data/events.json")).headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await get("/community-atlas/events.ics")).headers.get("Content-Type"), "text/calendar; charset=utf-8");
  assert.equal((await get("/community-atlas/data/events.json", "OPTIONS")).status, 204);
  assert.equal((await get("/community-atlas/embed/")).headers.get("Content-Security-Policy"), "frame-ancestors *");
  assert.equal((await get("/community-atlas/")).headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal((await get("/community-atlas/")).headers.get("Access-Control-Allow-Origin"), null);
});
