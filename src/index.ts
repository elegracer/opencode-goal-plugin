/**
 * opencode-goal-plugin — persistent session goals for OpenCode 2.
 *
 * V2-only: this package intentionally does not export a V1 `server()` hook.
 * The host reads `id` and `setup` from the default export (equivalent to
 * `Plugin.define`), which keeps the package dependency-free and git-installable.
 */

import type { PluginContext, PluginDefinition } from "./api.js";
import { GoalController } from "./controller.js";

const plugin: PluginDefinition = {
  id: "opencode-goal",
  async setup(ctx: PluginContext) {
    const controller = new GoalController(ctx);
    await controller.start();
    return () => controller.dispose();
  },
};

export default plugin;
export { GoalController } from "./controller.js";
export * from "./types.js";
