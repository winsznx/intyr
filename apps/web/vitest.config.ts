import { defineConfig } from "vitest/config";

/** Unit tests cover pure modules only, so they run without the React plugin or a browser. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
