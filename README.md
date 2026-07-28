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

**Manual, via Wrangler direct upload — there is no git integration.** Pushing to
this repository does *not* deploy anything.

```
npx wrangler pages deploy dist --project-name=timechain-wiki
```

A nightly job rebuilds the site from the knowledge base and deploys only if the
build is green, so content edits go live within a day without a manual step.

## Credits

Illustrations by **Anil Patel**, used with credit under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Per-figure
attribution and the full list are at [/credits](https://timechain.wiki/credits).

## History

The pre-launch coming-soon placeholder that used to occupy `main` is preserved
at the tag [`archive/coming-soon-2026-07`](https://github.com/RadVladdy/timechain-wiki/tree/archive/coming-soon-2026-07).
