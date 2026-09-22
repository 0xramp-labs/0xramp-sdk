import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Explicit opt-in: no Expo/Electron dependency installation or device launch.
export default defineConfig({
  resolve: { alias: { "@0xramp/sdk": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  test: { include: ["examples/**/*.test.ts"], environment: "node" },
});
