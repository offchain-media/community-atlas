# Hosting

The build writes `public/` with the same paths as the public site. Upload it as is.

## Cloudflare Workers (the offchain.media edition)

`wrangler.jsonc` defines the Worker `community-atlas`, with static assets from `public/` and 2 routes on the `offchain.media` zone:

- `offchain.media/atlas*`
- `offchain.media/fr/atlas*`

Routes only take these paths; the rest of offchain.media keeps being served as before. The zone must be in the same Cloudflare account as the Worker. No account id is stored in the repository.

First deployment, by hand:

```sh
npx wrangler login
npm run harvest && npm run build && npm test
npm run deploy:check
npm run deploy
```

Automatic deployment: add the repository secrets `CLOUDFLARE_API_TOKEN` (permission "Workers Scripts: Edit" and "Workers Routes: Edit" on the zone) and `CLOUDFLARE_ACCOUNT_ID`. `.github/workflows/refresh.yml` then harvests, tests, builds and deploys every 6 hours.

The atlas writes its own `sitemap.xml` under its path; add it to the site's sitemap index so search engines find it.

## GitHub Pages

For a project site at `https://<user>.github.io/<repo>/`, set `origin` to `https://<user>.github.io` and the first language `path` to `/<repo>/` in the profile; other languages must live below it, such as `/<repo>/fr/`. The workflow uploads `public/<repo>/`, which Pages serves at `/<repo>/`. Then set the repository variable `DEPLOY_PAGES` to `true` and Settings > Pages > Source to "GitHub Actions". Pages cannot set headers: data files are readable by other sites anyway (GitHub Pages sends `Access-Control-Allow-Origin: *`), and every page can be framed.

## Any static host

Upload `public/`. To match the Worker, add `Access-Control-Allow-Origin: *` on `data/*.json`, `events.ics` and `llms.txt`, and `X-Frame-Options: SAMEORIGIN` on pages other than `embed/`.
