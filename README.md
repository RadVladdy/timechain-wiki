# timechain-wiki

Static site for **[timechain.wiki](https://timechain.wiki)** — a clear,
citation-disciplined Bitcoin encyclopedia. A RadVladdy project.

## Current status

Coming-soon placeholder. Single static `index.html` at the repo root — no build
step. Cloudflare Pages serves the root directly.

## Deploy

**Manual, via Wrangler direct-upload — there is NO git integration** (the Pages
project shows `Git Provider: No`; a plain `git push` does NOT deploy). Deploy from
a directory containing just `index.html`:

```
CLOUDFLARE_API_TOKEN=$(cat ~/secure/cloudflare-pages-token) \
  npx wrangler pages deploy . --project-name=timechain-wiki --branch=main
```

`main` is the production branch, so this updates the live custom domain. Note the
`timechain.wiki` apex can lag the `timechain-wiki.pages.dev` alias by ~1 minute
after a fresh production deploy. No build step; output = the static files.

## Local preview

Open `index.html` in a browser, or:

```
python3 -m http.server 8000
```
