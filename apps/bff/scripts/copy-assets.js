// Copies the built React SPA (../web/dist) next to the BFF build output so a
// single Node process can serve both the API and the static frontend.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const webDist = resolve(root, "../web/dist");
const target = resolve(root, "public/spa");

mkdirSync(target, { recursive: true });

if (!existsSync(webDist)) {
  console.warn(
    `[build:copy] ${webDist} does not exist. Run "pnpm --filter @config-manager/web build" first.`,
  );
} else {
  cpSync(webDist, target, { recursive: true });
  console.log(`[build:copy] copied ${webDist} -> ${target}`);
}
