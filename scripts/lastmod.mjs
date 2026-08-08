// Sitemap <lastmod> dates, resolved from GIT COMMIT HISTORY.
//
// ⚠️ THE ARTICLE DATES COME FROM THE VAULT KB REPO, NOT FROM THIS ONE, AND THAT
// IS THE WHOLE POINT OF THIS FILE. src/content/wiki/ is gitignored here — it is
// re-synced from the Bitcoin KB on every build (sync-kb.py) — so it has NO git
// history to read and its mtimes are all "whenever the sync last ran". The
// nightly deploy (cron 04:25) runs that sync every single night, so an mtime- or
// local-git-based lastmod would tell Google all 394 articles changed today,
// every day, forever.
//
// That is not a missing signal but a FALSE one, and it is worse than emitting
// nothing: Google learns the field carries no information and stops trusting
// lastmod site-wide. On a site whose entire Search Console problem is 399 of 400
// URLs stuck in "Discovered - currently not indexed", teaching Google to
// disregard our one crawl-priority hint is precisely the wrong move.
//
// So each article's date is the last commit that touched its SOURCE NOTE in the
// vault — the real answer to "when did this content change". Pages that belong
// to this repo (/, /about, /credits, /highlights, /learn/*) use this repo's git.
//
// FAILURE MODE IS DEGRADE, NEVER BREAK. If the vault is unreachable (a fresh
// clone elsewhere, a cron run with no vault mounted), article dates are simply
// omitted and the build proceeds. A missing lastmod costs a hint; a thrown
// exception costs the nightly deploy.
//
// SHARED SCRIPT, ONE COPY PER REPO — only the resolver may differ, the same
// convention scripts/check-pseudonymity.py follows.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

/**
 * `-c core.quotePath=false` IS LOAD-BEARING, not a style choice. By default git
 * renders any non-ASCII byte in a path as a backslash escape and wraps
 * the whole path in quotes, so a filename with an umlaut, an accent or a dash
 * from outside Latin-1 never matches a lookup key. Measured on timechain.wiki:
 * exactly 3 of 400 articles silently lost their lastmod — Bohm-Bawerk, Hulsmann
 * and Walras — and nothing failed, which is what makes it worth a comment.
 */

/**
 * Last commit date per path, from ONE `git log` pass in `cwd`, optionally scoped
 * to a subdirectory. `git log` walks newest-first, so the FIRST appearance of a
 * path is its most recent commit — hence the `has()` guard.
 * Paths are returned RELATIVE TO THE REPO ROOT, which is why callers that scope
 * to a subdir must key on that same repo-root-relative form.
 */
function gitDates(cwd = '.', scope = '') {
  const cmd = `git -c core.quotePath=false log --format=%x00%cI --name-only --no-renames${scope ? ` -- ${JSON.stringify(scope)}` : ''}`;
  const out = execSync(cmd, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  const dates = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\0')) { current = line.slice(1).trim(); continue; }
    const p = line.trim();
    if (p && current && !dates.has(p)) dates.set(p, current);
  }
  return dates;
}

/** Where the Bitcoin KB lives — same resolution order sync-kb.py uses. */
function kbPath() {
  if (process.env.TIMECHAIN_KB) return process.env.TIMECHAIN_KB;
  if (existsSync('.kb-path')) return readFileSync('.kb-path', 'utf8').trim();
  return null;
}

/** slug -> last commit date of that article's source note in the vault. */
function articleDates() {
  const out = new Map();
  const kb = kbPath();
  if (!kb || !existsSync(kb) || !existsSync('src/lib/wiki-index.json')) return out;
  try {
    // The KB is a subdirectory of the vault repo, so find the repo root and the
    // KB's path within it; `git log` keys its --name-only output on that form.
    const root = execSync('git rev-parse --show-toplevel', { cwd: kb, encoding: 'utf8' }).trim();
    const prefix = execSync('git rev-parse --show-prefix', { cwd: kb, encoding: 'utf8' }).trim();
    const dates = gitDates(root, prefix.replace(/\/$/, ''));
    // wiki-index.json maps url slug -> the note's TITLE, and the note's filename
    // is "<Title>.md". Going through the index rather than re-slugifying
    // filenames keeps this in step with sync-kb.py's own slug rules.
    const index = JSON.parse(readFileSync('src/lib/wiki-index.json', 'utf8'));
    for (const [slug, title] of Object.entries(index)) {
      const d = dates.get(`${prefix}${title}.md`);
      if (d) out.set(slug, d);
    }
  } catch {
    // Vault unreachable or not a git repo — degrade to no article lastmods.
    return new Map();
  }
  return out;
}

function pathOf(url) {
  let p;
  try { p = new URL(url).pathname; } catch { p = url; }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

export function buildLastmod() {
  let local = new Map();
  try { local = gitDates(); } catch { /* not a git repo — degrade */ }
  const articles = articleDates();

  return (item) => {
    const p = pathOf(item.url);
    let date;

    const wiki = p.match(/^\/wiki\/(.+)$/);
    if (wiki) {
      date = articles.get(wiki[1]);
    } else {
      const clean = p.replace(/^\//, '');
      for (const c of p === '/'
        ? ['src/pages/index.astro']
        : [`src/pages/${clean}.astro`, `src/pages/${clean}/index.astro`]) {
        if (local.has(c)) { date = local.get(c); break; }
      }
    }

    // No date resolved => emit NO lastmod rather than a guess. A sitemap may
    // carry lastmod on some entries and not others; inventing one is the exact
    // failure this file exists to avoid.
    return date ? { ...item, lastmod: date } : item;
  };
}
