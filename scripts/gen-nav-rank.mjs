// Generates src/lib/nav-rank.generated.json — a compact slug → [section,
// cluster, position] map in NAV order, so the client can sort a reader's
// highlights hierarchically (same cluster first, then same section, then the
// rest of the wiki in walk order) without shipping the 130 KB sections tree.
// Runs as part of `npm run sync` (after sync-kb.py, which rebuilds the
// sections data this reads). Output is gitignored, like its source.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { GROUPS } = await import(join(ROOT, "src/lib/sections.js"));
const data = JSON.parse(readFileSync(join(ROOT, "src/lib/sections-data.json"), "utf8"));

const rank = {};
let si = 0;
for (const g of GROUPS) {
  for (const s of g.sections) {
    si++;
    rank[s.slug] = rank[s.slug] || [si, 0, 0];   // the section overview page itself
    const sec = data[s.slug];
    if (!sec) continue;
    let ci = 0;
    for (const c of sec.clusters || []) {
      ci++;
      let pi = 0;
      for (const e of c.entries || []) {
        pi++;
        if (e.slug && rank[e.slug] === undefined) rank[e.slug] = [si, ci, pi];
      }
    }
  }
}
writeFileSync(join(ROOT, "src/lib/nav-rank.generated.json"), JSON.stringify(rank));
console.log(`nav-rank: ${Object.keys(rank).length} slugs ranked across ${si} sections`);
