import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@avee\/sdk\/astra$/, replacement: fileURLToPath(new URL("./src/astra/index.ts", import.meta.url)) },
      { find: /^@avee\/sdk$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "compat/**/*.test.ts"],
    exclude: ["compat/astra/**"],
    testTimeout: 15000,
    pool: "forks",
  },
});
