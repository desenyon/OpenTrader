import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "server/index.ts",
    "create-admin": "scripts/create-admin.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist-server",
  external: ["vite"],
  // node:sqlite is available only through its node: name. tsup's legacy
  // default strips that prefix and incorrectly turns it into an npm import.
  removeNodeProtocol: false,
  clean: true,
});
