import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/main.tsx"],
      // The page components are still largely untested, so the global floor is deliberately
      // conservative. The data layer and shared primitives carry stricter per-file floors:
      // those are the paths every screen depends on, and they are cheap to keep covered.
      thresholds: {
        statements: 21,
        branches: 20,
        functions: 18,
        lines: 22,
        "src/live/client.ts": { statements: 95, branches: 85, functions: 95, lines: 95 },
        "src/live/sync.ts": { statements: 85, branches: 70, functions: 95, lines: 90 },
        "src/host-tasks.ts": { statements: 95, branches: 90, functions: 100, lines: 100 },
        "src/host-tree.ts": { statements: 95, branches: 90, functions: 100, lines: 100 },
        "src/components/ui.tsx": { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});
