import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import remarkWikiLink from "remark-wiki-link";
import { readFileSync } from "node:fs";

// Valid slugs come from the sync step (runs before build). Used so wikilinks to
// existing notes render as links and dangling ones get a distinct class.
let permalinks = [];
try {
  permalinks = Object.keys(JSON.parse(readFileSync("./src/lib/wiki-index.json", "utf-8")));
} catch { /* first run before sync — treat all links as new */ }

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export default defineConfig({
  // Canonical home. The preview (timechain-astro.pages.dev) deliberately builds
  // with apex canonicals/sitemap so the build is launch-ready and the preview
  // never competes with the real site in an index.
  site: "https://timechain.wiki",
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [
      [
        remarkWikiLink,
        {
          pathFormat: "raw",
          aliasDivider: "|",
          permalinks,
          pageResolver: (name) => [slugify(name)],
          hrefTemplate: (permalink) => `/wiki/${permalink}`,
          wikiLinkClassName: "wl",
          newClassName: "wl-new",
        },
      ],
    ],
  },
});
