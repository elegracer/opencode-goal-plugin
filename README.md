# opencode-goal-plugin

Persistent session goals for **OpenCode 2** (`opencode2`): a `/goal` workflow, evidence-gated completion, budgeted auto-continuation, and crash recovery.

- **V2-only.** Uses the OpenCode 2 `plugins` config and `Plugin.define` contract. It does not export a V1 `server()` hook.
- **Zero runtime dependencies.** The package imports nothing at runtime, so installing from git does not need a build step or a dependency install.
- **Correct by design.** Completion requires a real tool-call evidence candidate and is independently verified (model or agent tier) before a goal is marked complete.

## Install

Add the git package to `opencode.json(c)` (OpenCode 2 reads the plural `plugins` key):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "git+https://github.com/elegracer/opencode-goal-plugin.git"
  ]
}
```

or, equivalently:

```jsonc
{
  "plugins": ["github:elegracer/opencode-goal-plugin"]
}
```

Or let the CLI update the global config for you:

```sh
opencode2 plugin add git+https://github.com/elegracer/opencode-goal-plugin.git
```

> `git+https://…` (or the `github:` shorthand) is the canonical git spec; a bare `https://github.com/…` URL is treated as a tarball URL by package managers and does not work. Branches/tags/commits are supported: `git+https://github.com/elegracer/opencode-goal-plugin.git#main`.
>
> The package has zero runtime dependencies, no npm scripts, and no lockfile, and commits its compiled `dist/` plus a root `index.js` entry. That is deliberate: the OpenCode 2 host's embedded npm cannot run the "git dependency preparation" step on this build, but it skips preparation entirely for packages with nothing to prepare. Keeping the manifest minimal makes `github:` / `git+https://…` installs work out of the box.
>
> Verified against OpenCode `v2.0.22` on Linux: git install via `opencode2 plugin add`, plugin load, tool calls, command handling, auto-continuation, and evidence-gated completion.

With options (all optional):

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/elegracer/opencode-goal-plugin.git",
      "options": {
        "autoContinue": true,
        "verification": "model",
        "maxTurns": 10,
        "maxTokens": 100000,
        "maxMinutes": 30
      }
    }
  ]
}
```

Restart OpenCode after changing the plugin list.

### Updating

The host caches git plugin resolution, so a new commit may not appear until the cache is refreshed. Prefer pinning a commit for reproducible installs:

```jsonc
{ "package": "github:elegracer/opencode-goal-plugin#<commit>" }
```

To force a clean re-resolve on this build: remove `~/.cache/opencode/npm/git-opencode-goal-plugin-*`, delete npm cache index entries mentioning the repo (`grep -rl elegracer/opencode-goal-plugin ~/.npm/_cacache/index-v5`), then restart OpenCode.

## Usage

```
/goal <objective>                 set a goal and start working on it
/goal create <objective>          alias for the above
/goal status                      show the current goal (default)
/goal pause | resume              stop or re-arm automatic continuation
/goal edit <objective>            revise the objective in place
/goal block <reason>              record a specific blocker
/goal done <evidence>             complete with a checkable evidence summary
/goal clear                       archive and clear the current goal
/goal history                     lifecycle history and archive
/goal help                        command help
```

Flags for `/goal set` (also accepted on a plain `/goal <objective>`):

| Flag | Effect |
|---|---|
| `--turns N` | max auto-continuation turns |
| `--tokens N` | max context tokens (`100k`, `1.5m` accepted) |
| `--minutes N` / `--duration-ms N` | wall-clock cap |
| `--unbounded` | explicitly disable numeric caps |
| `--criteria "..."` | success criteria kept in context |
| `--constraints "..."` | constraints / non-goals |
| `--verify evidence\|model\|agent` | completion verification tier for this goal |

Examples:

```
/goal fix the failing tests --turns 12 --tokens 150k --criteria "npm test passes"
/goal migrate the config format --constraints "do not change the public API"
/goal long refactor --unbounded
```

## Agent tools

The model gets a small tool surface, all persisted and audited:

| Tool | Purpose |
|---|---|
| `goal_get` | status, budget usage, checkpoints, history, exact evidence candidate IDs |
| `goal_set` | create a goal (only when the user explicitly asks) |
| `goal_update` | `pause` / `resume` / `block` / `complete` with structured evidence |
| `goal_history` | lifecycle history and archive |
| `goal_clear` | intentionally refuses: only the user's `/goal clear` may clear a goal |

## How it works

1. **Context injection** — on every primary model call, `session.hook("context")` injects a `<goal_context>` block (objective, criteria, constraints, budget, checkpoints, evidence IDs). The goal text is labeled as user task data and cannot override system/developer/tool policies. Because the block is re-injected each call, compaction cannot lose the goal.
2. **Auto-continuation** — turn boundaries come from `session.execution.succeeded` (with `session.idle` only as a fallback, deduplicated by event id and a time window). At most one continuation prompt is in flight per session; user prompts pause continuation by default; `session.execution.interrupted` with reason `user` pauses, while `shutdown`/`superseded`/`inactivity` only cancel pending work; failures are paused only when no automatic retry follows.
3. **Budget accounting** — token/cost usage comes from `session.usage.updated` (accurate, not estimated). Goals count turns, latest context tokens, cumulative burn, and wall-clock active time. Default caps: 10 turns / 100k context tokens / 30 minutes; `--unbounded` opts out. When a cap trips, the goal becomes `budget_limited` / `usage_limited` / `stalled` and one wrap-up prompt asks for a summary.
4. **Evidence-gated completion** — every successful tool call is recorded as an evidence candidate keyed by its real call ID. `goal_update complete` must reference one of those exact IDs with a specific summary. Then:
   - `verification: "evidence"` — structural gate only;
   - `verification: "model"` (default) — one independent, tool-less model call (`ctx.generate.text`) adjudicates. The verifier model is resolved in order: explicit `verifierModel` option → the session's selected model → the host's default model. An unparsable verdict always rejects; a verifier *call* failure with an explicit `verifierModel` rejects (fail-closed), while an implicit verifier (session/host model) that cannot run — for example OpenCode's free tier, which refuses `generate` calls — degrades to the evidence gate and records the tier as `evidence (verifier unavailable)`;
   - `verification: "agent"` — a bounded child session inspects the workspace with tools and reports `VERDICT: APPROVED|REJECTED`.
   A rejected completion pauses the goal with the reason; it is never silently completed.
5. **Persistence and recovery** — goal state lives in host plugin storage (`ctx.storage`) per project/location/session. On startup, any goal still `active` is downgraded to `paused (recovered)` so unattended continuation never resumes blindly; `/goal resume` continues it.
6. **Session scoping** — only root sessions of the plugin's project/location drive continuation. Child (subagent) sessions never drive the loop, but they see the parent goal in context and can read it with `goal_get`.
7. **Command replies** — OpenCode 2 does not expose a plugin API that writes a user-visible chat message directly; `/goal …` results are delivered as synthetic messages that the model relays to the user on its next turn. State mutations themselves are local and do not depend on the model.

## Options

| Option | Default | Description |
|---|---|---|
| `autoContinue` | `true` | enable automatic continuation on turn boundaries |
| `continuationIntervalMs` | `1500` | delay before each continuation prompt |
| `maxTurns` / `maxTokens` / `maxDurationMs` | `10` / `100000` / `1800000` | default caps (`false` disables one) |
| `maxMinutes` | — | wall-clock cap in minutes (shorthand) |
| `noToolCallTurns` | `2` | consecutive tool-free continuation turns before `stalled` (`false` disables) |
| `noProgressTurns` | `0` (off) | consecutive low-output turns before `stalled` |
| `stallOutputTokens` | `50` | output-token floor for the low-output check |
| `verification` | `"model"` | `evidence` / `model` / `agent` |
| `verifierModel` | session / host default model | `"provider/model"` or `{ providerID, id, variant? }`; when set, verifier failures are fail-closed |
| `verifierTimeoutMs` | `300000` | verification timeout (fail-closed) |
| `onUserMessage` | `"pause"` | `pause` or `continue` when the user writes mid-goal |
| `wrapUpOnLimit` | `true` | send one final summary prompt when a cap trips |
| `commandName` | `"goal"` | rename the slash command |
| `contextInjectionMaxChars` | `4000` | goal block size cap |
| `maxPromptFailures` | `3` | consecutive continuation prompt failures before pausing |
| `debug` | `false` | verbose plugin logging |

## Persistence and limitations

- State is stored through the host plugin storage; this plugin never writes goal JSON files.
- The storage has no compare-and-set. Run a **single OpenCode server per storage database**; two servers sharing one database race on last-write-wins.
- Evidence candidates are in-memory: after a restart the model must produce fresh successful tool calls before completing.
- The `agent` verification tier needs the host to allow child sessions; on hosts where it fails, completion is rejected (fail-closed) and the goal pauses.
- OpenCode 2 plugin APIs are still evolving. This package targets `@opencode/plugin` 2.0.22 semantics (`session.execution.*`, `session.usage.updated`, `session.hook("context"|"prompt")`, `tool.hook("execute.after")`). Check the host version with `opencode2 --version`.

## Development

The published manifest intentionally has no scripts, devDependencies, or lockfile so git installs skip npm's git-preparation step (see Install). Develop with direct commands:

```sh
npm install --no-save typescript   # dev-only, does not modify package.json
npx tsc -p tsconfig.json           # typecheck + build dist/
node --test "test/*.test.mjs"      # unit/integration tests (run after build)
```

`dist/` is committed on purpose so installs work without a build step. After changing `src/`, run `npx tsc -p tsconfig.json` and commit the updated `dist/`.

## License

MIT
