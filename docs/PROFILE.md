# Profile reference

A profile is a folder in `profiles/` with a `profile.json` and optional files. The build reads it with `--profile profiles/<name>` or `ATLAS_PROFILE=profiles/<name>`. It stops with a list of problems when a key is invalid.

## profile.json

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Short identifier, used in logs. |
| `name` | yes | Name shown in the header, titles and calendar. |
| `tagline` | no | `{ "en": "...", "fr": "..." }`: page description for search engines and social previews. |
| `publisher` | no | `{ "name", "url", "logo" }`. `logo` is an SVG file in the profile folder, shown in the header and coloured with the text colour. |
| `origin` | yes | Public origin without a path, such as `https://offchain.media`. Used for canonical links, sitemap and embed code. |
| `languages` | yes | List of `{ "code", "name", "path" }`. `path` is where that language is served, starting and ending with `/`. Each code needs `src/i18n/<code>.json`. |
| `assetsPath` | no | Where scripts, styles and data are served. Defaults to the first language's path. |
| `repository` | no | Your fork, linked from the footer and the About page. |
| `scope` | yes | `{ "type": "world" }`, `{ "type": "countries", "countries": ["LT", "LV"] }` (BTC Map country shapes) or `{ "type": "bbox", "bbox": [west, south, east, north] }`. Applies to places, communities and events. |
| `map` | yes | `center` `[lon, lat]`, `zoom`, optional `minZoom`, `maxZoom`, `maxBounds` `[[w, s], [e, n]]`, `styles` `{ "light": url, "dark": url }` (default: OpenFreeMap Positron and Dark). |
| `sources` | yes | `merchants`, `communities`, `meetup`, `planb`: `true` or `false`. `feeds`: list of community feeds, see below. |
| `theme` | no | `accent`, `accentText` `{ light, dark }`, `background` `{ light, dark }`, `text` `{ light, dark }`, `fonts` `{ heading, body }` (names of installed `@fontsource/*` packages), `uppercaseHeadings`. |
| `shareImage` | no | Image file in `assets/` of the output for social previews. |
| `keepPastDays` | no | How long past events stay listed. Default 730. |

### A feed

```json
{ "name": "Lithuania BTC", "url": "https://lithuaniabtc.com/data/events.json",
  "site": "https://lithuaniabtc.com/en/", "eventPage": "/en/events/{id}/",
  "country": "LT", "timeZone": "Europe/Vilnius" }
```

`eventPage` is the address of an event's own page on that site, with `{id}` replaced by the event id. Without it, events link to `site`. `country` and `timeZone` fill in events that do not state them.

## events.json (optional)

Events you publish yourself, in the [feed format](DATA.md#feed-format). They take priority over the same event from another source.

## ecosystem.json (optional)

```json
{ "rule": "bitcoin-only", "verifiedAt": "2026-11-05",
  "companies": [ { "id": "sparrow", "name": "Sparrow Wallet", "url": "https://sparrowwallet.com",
    "category": "wallet", "country": null,
    "description": { "en": "...", "fr": "..." },
    "evidence": "https://...", "evidenceNote": "...", "verifiedAt": "2026-11-05",
    "verification": "read", "review": "pending" } ] }
```

Categories: `wallet`, `hardware`, `broker`, `payments`, `lightning`, `node`, `mining`, `finance`, `custody`, `education`, `privacy`. While any entry has `"review": "pending"`, the page says the selection is being reviewed. Without this file, the Ecosystem tab is hidden.

## Languages

Interface strings live in `src/i18n/<code>.json`. To add a language, copy `en.json`, translate every value and add the language to `languages`. Event titles stay in the language their organisers used.
