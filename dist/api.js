/**
 * Structural slice of the OpenCode 2 plugin API used by this plugin.
 *
 * This package intentionally has ZERO runtime dependencies:
 * - `Plugin.define` from `@opencode/plugin` is an identity helper; V2 reads
 *   `id` and `setup` from the default export, so a plain object works.
 * - Therefore we do not import `@opencode/plugin` at runtime. The types below
 *   mirror the `@opencode/plugin@2.0.x` Promise API surface we rely on, which
 *   keeps git/npm installs dependency-free and robust.
 *
 * See docs/RESEARCH-AND-PLAN.md and README.md for the compatibility matrix.
 */
export {};
