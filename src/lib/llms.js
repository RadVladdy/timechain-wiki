// Shared helpers for the machine-readable endpoints (/llms.txt, /llms-full.txt,
// /wiki/<slug>.md). The site's canonical home, per astro.config `site`.
import titles from "./wiki-index.json";

export const SITE = "https://timechain.wiki";

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Rewrite Obsidian-style [[wikilinks]] into plain markdown links aimed at the
// raw-markdown endpoints, so an agent reading one article can walk to the next
// without ever touching HTML. Dangling links degrade to their display text.
export function mdLinks(body) {
  return body.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, target, alias) => {
    const slug = slugify(target.trim());
    const text = (alias ?? target).trim();
    return titles[slug] ? `[${text}](${SITE}/wiki/${slug}.md)` : text;
  });
}

// A raw-markdown document for one article: title header + canonical pointer,
// then the synced body (Editor's Notes already stripped at sync time).
export function mdDoc(entry) {
  const title = titles[entry.id] ?? entry.id;
  const d = entry.data;
  const meta = [d.type, d.area, d.level].filter(Boolean).join(" · ");
  return [
    `# ${title}`,
    ``,
    `> Source: ${SITE}/wiki/${entry.id} · TimechainWiki, the Bitcoin encyclopedia.${meta ? ` (${meta})` : ""}`,
    ``,
    mdLinks(entry.body ?? ""),
    ``,
  ].join("\n");
}
