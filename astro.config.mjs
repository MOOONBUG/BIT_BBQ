// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  site: "https://mooon3.wooou-bill.workers.dev",
  integrations: [mdx(), sitemap()],
  output: "static",
});
