import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// The Bitcoin KB notes, synced (Editor's Notes stripped) into src/content/wiki.
// Filenames are slugs, so entry.id === url slug. Schema is permissive — the KB
// carries many frontmatter fields; we validate only what the site reads.
const wiki = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/wiki" }),
  schema: z
    .object({
      title: z.string().optional(),
      type: z.string().optional(),
      area: z.string().optional(),
      level: z.string().optional(),
      // KB tags are usually strings but occasionally include a bare number (e.g. 1971);
      // accept anything and normalise to strings at render.
      tags: z.any().optional(),
    })
    .passthrough(),
});

export const collections = { wiki };
