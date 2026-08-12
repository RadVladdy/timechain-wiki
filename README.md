# Timechain Wiki

Source for **[timechain.wiki](https://timechain.wiki)** — a media-neutral Bitcoin
encyclopedia. A RadVladdy project.

"Timechain" is Satoshi's original term for the block data structure.

## What it is

A 400-page reference covering Bitcoin's history, mechanics, economics, culture,
and criticisms. It is written to read as an encyclopedia rather than advocacy:
contested topics are presented with their strongest arguments on each side, and
the editorial position stays out of the page body.

The site is structure-forward. Rather than a flat A–Z list, it walks down
**movement → section → cluster → entry**, mirroring how the material is actually
organised, so you can browse by shape as well as search.

## Features

- **Full-text search** (Pagefind) — `⌘K` / `Ctrl-K` anywhere
- **Reader annotation** — select any passage to highlight and take notes. Works
  logged out and offline; nothing leaves your browser unless you ask it to.
- **Bring your own identity** — sign in with [Nostr](https://timechain.wiki/learn/nostr)
  or [Pubky](https://timechain.wiki/learn/pubky) and highlights sync across your
  devices via **your own** accounts. The wiki stores none of it.
  - Private encrypted sync (NIP-78/44) is the default
  - Public highlights (NIP-84 kind-9802) are opt-in, per-item or globally
- **Reader suggestions** — propose an edit on any passage, publicly or by
  encrypted DM. Every suggestion is read by hand; none are auto-applied.
- **Built for agents as well as people** — `robots.txt`, `sitemap.xml`,
  [`/llms.txt`](https://timechain.wiki/llms.txt), `/llms-full.txt`, and raw
  markdown for every article at `/wiki/<slug>.md` with wikilinks rewritten so a
  crawler can walk page to page without parsing HTML.

## How it's built

[Astro](https://astro.build) 5, no UI framework, minimal client JS. The
anonymous-reader bundle stays small — the Nostr and Pubky libraries are
lazy-loaded and never touch the page unless you sign in.

Content is authored in a separate knowledge base and pulled in by `sync-kb.py`,
which normalises the notes, resolves wikilinks to site URLs, and parses the
navigation hierarchy. A **leak guard** fails the build outright if any internal
editorial marker survives the sync, so drafting notes cannot reach production.

```
npm install
npm run build      # runs sync-kb.py, builds, indexes search
npm run dev
```

## Deploy

**Wrangler direct upload — there is no git integration.** Pushing to this
repository does *not* deploy anything. One command, the same one in every site
repo:

```
npm run deploy
```

That builds, then runs `scripts/deploy.sh`, which sources the Cloudflare token
itself. This site is a **Pages** project (`timechain-wiki`), so the script uses
the Pages-scoped token.

**The nightly is the sanctioned exception to "deploying is a manual act."** This
site's content is generated from the Bitcoin KB, so it has to be able to go live
without a person: `nightly-deploy.sh` (cron 04:25) rebuilds and then calls the
**same** `scripts/deploy.sh`, so the automated and manual paths are one
implementation rather than two that drift. The build's leak-guard fails the build
on any internal-content leak, and the deploy only runs if the build succeeds — so
a bad sync cannot ship.

## Credits

Illustrations by **Anil Patel**, used with credit under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Per-figure
attribution and the full list are at [/credits](https://timechain.wiki/credits).

## A note on the branches

**`main` is the live site, and it is the only branch.** The pre-launch
coming-soon placeholder that used to live on `main` was retired at the
2026-07-29 consolidation; its history is preserved at the tag
[`archive/coming-soon-2026-07`](https://github.com/RadVladdy/timechain-wiki/releases/tag/archive%2Fcoming-soon-2026-07).
The former `astro-build` branch was renamed to `main` and no longer exists —
GitHub redirects old links to it.

## Licence

**Code: [MIT](LICENSE). Content: [CC BY 4.0](LICENSE-CONTENT).**

Every entry is yours to copy, translate, remix or use as training and
retrieval data — credit RadVladdy and link back. This encyclopedia already
indexes itself at `/llms.txt` and serves every entry as clean markdown; the
licence is what makes that invitation lawful rather than merely friendly.
