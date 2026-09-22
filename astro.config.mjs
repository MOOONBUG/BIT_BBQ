// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  site: "https://mooonstoreclinic.top",
  trailingSlash: "always",
  i18n: { defaultLocale: "en", locales: ["en", "ko", "ja", "zh-hant", "ru", "fr"], routing: { prefixDefaultLocale: false } },
  integrations: [mdx(), sitemap()],
  output: "static",
});
