import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Builds the inbox admin SPA (admin/) into public/admin/, which the Worker
// serves as static assets at /admin/. Base is /admin/ so asset URLs resolve
// under that path. The SPA uses in-app tab state (no client-side routing), so
// it needs no SPA history fallback beyond /admin/index.html.
export default defineConfig({
  root: __dirname,
  base: "/admin/",
  plugins: [svelte()],
  build: {
    outDir: "../public/admin",
    emptyOutDir: true,
  },
});
