import solidPlugin from "@opentui/solid/bun-plugin";

const root = "/home/huangkai/codes/opencode-goal-plugin";
const result = await Bun.build({
  entrypoints: [root + "/src/tui.tsx"],
  target: "bun",
  format: "esm",
  plugins: [solidPlugin],
  outdir: "/tmp/opencode/bundle-test",
  naming: "tui.js",
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log("bundled");
