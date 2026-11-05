# Profile reference

A profile is a folder in `profiles/` with a `profile.json` and optional files. The build reads it with `--profile profiles/<name>` or `ATLAS_PROFILE=profiles/<name>`. It stops with a list of problems when a required key is missing or invalid. An `about` key is ignored: use it for a note to the next maintainer.

## profile.json

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Short identifier (letters, digits, `-`, `_`), printed by the build. |
| `name` | yes | Name shown in the header, titles and calendar. |
| `tagline` | no | `{ "en": "...", "fr": "..." }`: page description for search engines and social previews. |
| `publisher` | no | `{ "name", "url", "logo" }`. `logo` is an SVG file in the profile folder, shown in the header and coloured with the text colour. |
| `origin` | yes | Public origin without a path, such as `https://offchain.media`. Used for canonical links, sitemap and embed code. |
| `languages` | yes | List of `{ "code", "name", "path" }`. `name` is shown in the language switcher. `path` is where that language is served, starting and ending with `/`. Each code needs `src/i18n/<code>.json`. |
| `assetsPath` | no | Where scripts, styles and data are served. Defaults to the first language's path. |
| `repository` | no | Your fork, linked from the footer and the About page. |
| `scope` | yes | `{ "type": "world" }`, `{ "type": "countries", "countries": ["LT", "LV"] }` (BTC Map country shapes) or `{ "type": "bbox", "bbox": [west, south, east, north] }`. Applies to places, communities and events. |
| `map` | yes | `center` `[lon, lat]`, `zoom`, optional `minZoom`, `maxZoom`, `maxBounds` `[[w, s], [e, n]]`, `styles` `{ "light": url, "dark": url }` (default: OpenFreeMap Positron and Dark). With another style, list in `connectSrc` every other origin it loads tiles, fonts or sprites from, so the page's security policy allows them. |
| `sources` | yes | `merchants`, `communities`, `meetup`, `planb`: `true` to use them (a missing key means off). `feeds`: list of community feeds, see below. |
| `theme` | no | `accent`, `accentText` `{ light, dark }`, `background` `{ light, dark }`, `text` `{ light, dark }`, `fonts` `{ heading, body }` (names of installed `@fontsource/*` packages), `uppercaseHeadings`. |
| `shareImage` | no | Image file in the profile folder (1200 × 630), copied into the build and used for social previews. |
| `keepPastDays` | no | How long past events stay listed. Default 730. |

### A feed

```json
{ "name": "Lithuania BTC", "url": "https://lithuaniabtc.com/data/events.json",
  "site": "https://lithuaniabtc.com/en/", "eventPage": "/en/events/{id}/",
  "country": "LT", "timeZone": "Europe/Vilnius" }
```

`eventPage` is the address of an event's own page on that site, with `{id}` replaced by the event id; the atlas credits the site with that link. An event links to its own `url` when it has one, otherwise to that page or to `site`. `country` and `timeZone` fill in events that do not state them.

## events.json (optional)

Events you publish yourself, in the [feed format](DATA.md#feed-format). When another source publishes the same event, yours is kept and the other is linked as "also listed by".

## ecosystem.json (optional)

```json
{ "rule": "bitcoin-only", "verifiedAt": "2026-11-05",
  "companies": [ { "id": "sparrow", "name": "Sparrow Wallet", "url": "https://sparrowwallet.com",
    "category": "wallet", "country": null,
    "description": { "en": "...", "fr": "..." },
    "evidence": "https://...", "evidenceNote": "...", "verifiedAt": "2026-11-05",
    "verification": "read", "review": "pending" } ] }
```

Categories: `wallet`, `hardware`, `broker`, `payments`, `lightning`, `node`, `mining`, `finance`, `custody`, `education`, `privacy`.

An entry is published only when `verification` is `read` (the evidence page was read) or `review` is `approved` (an editor checked it). Other entries stay in the file as candidates. `verification`, `review` and `evidenceNote` are not published. While a published entry is not `approved`, the page says the selection is being reviewed. With no published entry, the Ecosystem tab is hidden.

## Languages

Interface strings live in `src/i18n/<code>.json`. To add a language, copy `en.json`, translate every value and add the language to `languages`. An event title is shown in the page's language when its source gives a translation (`title: { "en": ..., "lt": ... }` in a feed), otherwise as published.
