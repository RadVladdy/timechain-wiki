// /llms.txt — the llmstxt.org index: the wiki's full structure (movement →
// section → cluster → entry) as one curated markdown map, links aimed at the
// raw-markdown endpoints.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { GROUPS } from "../lib/sections.js";
import sectionsData from "../lib/sections-data.json";
import titles from "../lib/wiki-index.json";
import { SITE } from "../lib/llms.js";

export const GET: APIRoute = async () => {
  const all = await getCollection("wiki");
  const nameOf = (id: string) => (titles as Record<string, string>)[id] ?? id;
  const md = (slug: string) => `${SITE}/wiki/${slug}.md`;

  const lines: string[] = [
    `# TimechainWiki`,
    ``,
    `> The Bitcoin encyclopedia — a structured, non-tribal reference rendered from a hand-curated Bitcoin knowledge base. Seven movements, 16 sections, ~400 articles, each walkable below.`,
    ``,
    `Every article is served as clean markdown at /wiki/<slug>.md (same path as the HTML page, plus \`.md\`). The full concatenated text of the encyclopedia is at [/llms-full.txt](${SITE}/llms-full.txt). All pages are static HTML — no JavaScript needed to read anything.`,
    ``,
  ];

  const listed = new Set<string>();
  for (const group of GROUPS) {
    for (const section of group.sections) {
      lines.push(`## ${group.roman}. ${group.label} — ${section.title}`, ``);
      if (section.scope) lines.push(`> ${section.scope}`, ``);
      lines.push(`- [${section.title} (section overview)](${md(section.slug)})`);
      listed.add(section.slug);
      const sec = (sectionsData as any)[section.slug];
      for (const cluster of sec?.clusters ?? []) {
        for (const e of cluster.entries) {
          if (!e.hasPage || listed.has(e.slug)) continue;
          listed.add(e.slug);
          const level = e.level ? ` (${e.level})` : "";
          lines.push(`- [${e.title}](${md(e.slug)})${level}${e.desc ? `: ${e.desc}` : ""}`);
        }
      }
      // The section's thinker and source rails — real pages, not in any cluster.
      const rail = all
        .filter((x) => (x.data.type === "thinker" || x.data.type === "source") && x.data.area === section.area && !listed.has(x.id))
        .sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));
      for (const x of rail) {
        listed.add(x.id);
        lines.push(`- [${nameOf(x.id)}](${md(x.id)}) (${x.data.type})`);
      }
      lines.push(``);
    }
  }

  // Anything not reachable through the walk-down (root MOCs, cross-cutting notes).
  const rest = all.filter((x) => !listed.has(x.id)).sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));
  if (rest.length) {
    lines.push(`## Optional — further pages`, ``);
    for (const x of rest) lines.push(`- [${nameOf(x.id)}](${md(x.id)})`);
    lines.push(``);
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
