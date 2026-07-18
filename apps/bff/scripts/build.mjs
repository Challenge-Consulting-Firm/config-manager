// Bundle the BFF (and the in-repo @config-manager/shared package) into a single
// ESM file that raw `node` can run in production. External packages (hono,
// iron-session, etc.) and node built-ins stay external.
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(root, "dist/index.js"),
  sourcemap: true,
  // Keep npm deps external. Node built-ins (node:*) are auto-external for
  // platform "node". The workspace package @config-manager/shared is NOT in
  // this list, so esbuild follows its node_modules symlink and bundles the TS
  // source into the output.
  external: [
    "hono",
    "hono/*",
    "@hono/node-server",
    "@hono/node-server/*",
    "iron-session",
    "esbuild",
  ],
  logLevel: "info",
});

console.log("[build] BFF bundled to dist/index.js");
