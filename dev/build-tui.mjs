/**
 * Build the TUI widget to plain JS with the OpenTUI Solid Bun plugin.
 *
 * The host's Solid/JSX transform skips files under `node_modules`, so a git or
 * npm install never compiles our `.tsx`. Shipping a pre-compiled module with
 * bare specifiers preserved lets the host's runtime-module layer resolve them
 * to its own Solid/OpenTUI instances (shared reactivity).
 *
 * Usage: dev/node_modules/.bin/bun dev/build-tui.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "@opentui/solid/bun-plugin";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await Bun.build({
  entrypoints: [join(root, "src", "tui.tsx")],
  target: "bun",
  format: "esm",
  external: [
    "@opentui/solid",
    "@opentui/solid/components",
    "@opentui/solid/jsx-runtime",
    "@opentui/solid/jsx-dev-runtime",
    "@opentui/core",
    "solid-js",
    "solid-js/store",
  ],
  plugins: [solidPlugin],
  outdir: join(root, "dist"),
  naming: "tui.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built dist/tui.js");
