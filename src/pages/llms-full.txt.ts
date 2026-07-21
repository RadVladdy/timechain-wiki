// /llms-full.txt — the whole encyclopedia as one concatenated markdown file,
// for agents that want to slurp (or range-request) everything at once.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import titles from "../lib/wiki-index.json";
import { SITE, mdDoc } from "../lib/llms.js";

export const GET: APIRoute = async () => {
  const all = await getCollection("wiki");
  const nameOf = (id: string) => (titles as Record<string, string>)[id] ?? id;
  all.sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));

  const head = [
    `# TimechainWiki — full text`,
    ``,
    `> Every article of the Bitcoin encyclopedia, concatenated (${all.length} articles, alphabetical). Structured index: ${SITE}/llms.txt · per-article markdown: ${SITE}/wiki/<slug>.md`,
    ``,
  ].join("\n");

  const body = all.map((e) => mdDoc(e)).join("\n---\n\n");
  return new Response(head + "\n" + body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
