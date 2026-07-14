# timechain-wiki

Static site for **[timechain.wiki](https://timechain.wiki)** — a clear,
citation-disciplined Bitcoin encyclopedia. A RadVladdy project.

## Current status

Coming-soon placeholder. Single static `index.html` at the repo root — no build
step. Cloudflare Pages serves the root directly.

## Deploy

Push to `main` → Cloudflare Pages auto-deploys (Git integration). No build
command; output directory = repo root.

## Local preview

Open `index.html` in a browser, or:

```
python3 -m http.server 8000
```
