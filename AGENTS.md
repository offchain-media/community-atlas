# Instructions for AI assistants

You help a person, often the organiser of a Bitcoin meetup or community, make **their own atlas** from this repository, or embed the existing one on their site. They may not be a developer. Read this file, then `README.md` and `docs/PROFILE.md`, before changing anything.

## Ground rules

1. **Ask first what they want:** embed the Off-Chain Media atlas on their site (no fork: give the iframe code from the README, filtered by country or community), or run their own atlas (fork).
2. **Never ask for or write a password, token, API key, recovery phrase or payment detail.** Logins happen in the person's own browser or terminal.
3. **Never delete files, rewrite Git history or deploy without explicit permission.** Building and previewing locally is always fine.
4. **Configuration first.** Work in `profiles/<their-name>/`. Touch `src/`, `scripts/` or `worker.mjs` only when the profile cannot do it, and say why.
5. **Never invent data.** No made-up events, coordinates, companies or links. An event without a confirmed date is `"status": "planned"` with no `start`. A company in `ecosystem.json` needs an `evidence` link; set `"verification": "read"` only when that page was actually read, otherwise leave it for an editor to approve.
6. **Keep the attributions and licences** (`THIRD_PARTY.md`, footer, About page). Replace the Off-Chain Media logo; it is not licensed.

## Steps for a new atlas

1. Copy `profiles/example-region/` to `profiles/<slug>/`.
2. Ask, 1 block at a time, with a default for each: name and tagline; languages (`en`, `fr` exist in `src/i18n/`); public address (`origin` and `path`); area (`world`, a list of country codes, or a bounding box) and the starting map view; which sources to keep; event feeds of local communities (only with their agreement); colours; publisher name and SVG logo.
3. Write `profile.json`, then run:
   ```sh
   npm ci
   ATLAS_PROFILE=profiles/<slug> npm run harvest   # behind a proxy: NODE_USE_ENV_PROXY=1
   node scripts/build.mjs --profile profiles/<slug>
   npm run preview
   ```
   Open the printed address and check the map, the events, the About page, a phone width and dark mode.
4. Optional: `events.json` for events they publish themselves (see `docs/DATA.md`), `ecosystem.json` for companies.
5. Publishing: explain the 2 options of `docs/HOSTING.md` (Cloudflare or GitHub Pages) and let them choose. Set `vars.ATLAS_PROFILE` in the repository so the refresh workflow builds their profile.

## Checks before you finish

`npm test` passes; `node scripts/build.mjs --profile profiles/<slug>` prints counts that make sense; no page references a path outside the profile's paths; no secret is in the diff.
