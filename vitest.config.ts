import { defineConfig } from "vitest/config";

// Router/flow/signature unit + integration tests run in plain Node (real
// WebCrypto is available on globalThis.crypto). Persistence in tests uses the
// in-memory Store fake (src/db/memory.ts); the real D1-backed Store is
// exercised live via `wrangler dev` + the simulator (see README).
export default defineConfig({
  plugins: [
    {
      // Mirror wrangler's `rules` Text module for kb/*.md imports.
      name: "raw-md",
      transform(code, id) {
        if (id.endsWith(".md")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
      },
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
