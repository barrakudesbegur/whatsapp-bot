import { defineConfig } from "vitest/config";

// Router/flow/signature unit + integration tests run in plain Node (real
// WebCrypto is available on globalThis.crypto). Persistence in tests uses the
// in-memory Store fake (src/db/memory-store.ts); the real D1-backed Store is
// exercised live via `wrangler dev` + the simulator (see README).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
