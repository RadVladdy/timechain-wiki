// /wiki/<slug>.md — each article as clean markdown (same path as the HTML
// page plus `.md`), so agents can read entries without parsing HTML.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { mdDoc } from "../../lib/llms.js";

export async function getStaticPaths() {
  const entries = await getCollection("wiki");
  return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}

export const GET: APIRoute = ({ props }) => {
  return new Response(mdDoc(props.entry), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
