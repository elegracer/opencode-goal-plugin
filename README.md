# opencode-goal-plugin

Persistent session goals for **OpenCode 2** (`opencode2`): a `/goal` workflow with evidence-gated completion, automatic continuation, a live TUI sidebar, and crash recovery.

- **V2-only.** Uses the OpenCode 2 `plugins` config and the `id`/`setup` plugin contract. No V1 `server()` hook.
- **No budget limits.** Like Codex goal mode, a goal keeps running until you pause/clear it or the model completes/blocks. Token/cost/turn usage is shown for information only.
- **Correct by design.** Completion requires a real tool-call evidence candidate and is independently verified (model tier) before a goal is marked complete.
- **Zero runtime dependencies.** Git installs work without a build or dependency step; OpenTUI/Solid are provisioned as peers for the TUI sidebar.
- **Typo-safe commands.** A misspelled verb (`/goal paus`, `/goal cleer`) is rejected with a suggestion instead of silently becoming a new goal.

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

or:

```jsonc
{ "plugins": ["github:elegracer/opencode-goal-plugin"] }
```

Or let the CLI update the global config:

```sh
opencode2 plugin add git+https://github.com/elegracer/opencode-goal-plugin.git
```

> `git+https://…` (or the `github:` shorthand) is the canonical git spec; a bare `https://github.com/…` URL is treated as a tarball URL and does not work. Branches/tags/commits are supported: `…#main` or `…#<commit>`.
>
> The package has zero runtime dependencies, no npm scripts, and no lockfile, and commits its compiled `dist/`. That is deliberate: the OpenCode 2.0.22 host's embedded npm cannot run git-dependency preparation, but it skips preparation entirely for packages with nothing to prepare.
>
> No `cli.json` entry is required: the package's `./tui` export loads automatically and updates live. Do not also install the local adapter from `examples/` — two widgets would render.
>
> Restart the client after changing the plugin list. The sidebar needs the managed service; in `--standalone` (private stdio) mode the RPC does not resolve on 2.0.22.

### Updating

The host caches git plugin resolution, so a new commit may not appear until the cache is refreshed. Prefer pinning a commit for reproducible installs. To force a clean re-resolve: remove `~/.cache/opencode/npm/git-opencode-goal-plugin-*`, delete npm cache index entries mentioning the repo (`grep -rl elegracer/opencode-goal-plugin ~/.npm/_cacache/index-v5`), then restart or run `opencode2 reload`.

## Usage

```
/goal <objective>                 set a goal and start working on it
/goal set <objective>             same, explicit form
/goal status                      show the current goal (default)
/goal pause | resume              stop or re-arm automatic continuation
/goal edit <objective>            revise the objective in place
/goal block <reason>              record a specific blocker
/goal done <evidence>             complete with a checkable evidence summary
/goal clear                       clear the current goal (hides the sidebar card)
/goal history                     lifecycle history and archive
/goal task add <title>            add a task to the goal's task list
/goal task <ref> todo|doing|done  update a task (ref = id or number)
/goal task list                   list tasks
/goal help                        command help
```

Aliases kept so common synonyms can never become goal text: `complete`→done, `cancel`→clear, `stop`→pause, `continue`→resume. Anything else that looks like a mistyped command is rejected with a suggestion; to set a goal whose text starts with such a word, use `/goal set <objective>`.

Flags for `set`:

| Flag | Effect |
|---|---|
| `--criteria "..."` | success criteria kept in context |
| `--constraints "..."` | constraints / non-goals |
| `--verify evidence\|model` | completion verification tier for this goal |

Examples:

```
/goal fix the failing tests --criteria "npm test passes"
/goal migrate the config format --constraints "do not change the public API"
/goal long refactor
```

## Agent tools

| Tool | Purpose |
|---|---|
| `goal_get` | status, usage, tasks, checkpoints, history, exact evidence candidate IDs |
| `goal_set` | create a goal (only when the user explicitly asks) |
| `goal_update` | `pause` / `resume` / `block` / `complete` with structured evidence |
| `goal_add_task` | add a task to the goal's task list |
| `goal_update_task` | set a task `todo` / `doing` / `done` (by id or number) |
| `goal_history` | lifecycle history and archive |
| `goal_clear` | intentionally refuses: only the user's `/goal clear` may clear a goal |

## How it works

1. **Context injection** — on every primary model call, `session.hook("context")` injects a `<goal_context>` block (objective, criteria, constraints, status, usage, tasks, checkpoints, evidence IDs). The goal text is labeled as user task data and cannot override system/developer/tool policies. The block is re-injected each call, so compaction cannot lose the goal; `session.hook("compaction")` additionally adds a one-line goal snapshot to the summarizer.
2. **Auto-continuation** — turn boundaries come from `session.execution.succeeded` (with `session.idle` only as a fallback, ignored once execution events are seen). At most one continuation prompt is in flight per session; user prompts pause continuation by default; `execution.interrupted` with reason `user` pauses, while `shutdown`/`superseded`/`inactivity` only cancel pending work; failures pause only when no automatic retry follows. Continuations are deduplicated across plugin instances with a persisted `lastContinuationAt` window plus storage-nonce claim arbitration. There are **no turn/token/duration caps** — the goal runs until paused, cleared, completed, or blocked.
3. **Usage accounting (display only)** — `session.usage.updated` reports cumulative totals; the plugin differences consecutive snapshots so you see the latest call's own context size plus cumulative burn/cost. Nothing stops the goal based on usage.
4. **Evidence-gated completion** — every successful tool call is recorded as an evidence candidate keyed by its real call ID. `goal_update complete` must reference one of those exact IDs with a specific summary, then:
   - `verification: "evidence"` — structural gate only;
   - `verification: "model"` (default) — one independent, tool-less model call adjudicates. The verifier model resolves as: explicit `verifierModel` → session model → host default model. An unparsable verdict always rejects; a verifier call failure with an explicit `verifierModel` rejects (fail-closed), while an implicit verifier that cannot run (e.g. free-tier restrictions) degrades to the evidence gate and records `evidence (verifier unavailable)`.
   A rejected completion pauses the goal with the reason; it is never silently completed.
5. **Persistence and recovery** — goal state lives in host plugin storage per project/location/session, with a session index and a cross-scope fallback for RPC lookups. On startup, any goal still `active` is downgraded to `paused (recovered)` so unattended continuation never resumes blindly; `/goal resume` continues it.
6. **Session scoping** — only root sessions drive continuation. Child (subagent) sessions never drive the loop, but they see the parent goal in context and can read it with `goal_get`.
7. **Command replies** — OpenCode 2 has no plugin API that writes a user-visible chat message directly; `/goal …` results are delivered as synthetic messages that the model relays on its next turn. State mutations themselves are local and do not depend on the model.
8. **TUI sidebar (RPC)** — the server plugin registers a `goals.get` RPC and emits `goals.updated` on every goal write (debounced). The `./tui` entry renders a sidebar widget (status, objective, usage, task progress) that refreshes on those events; it renders nothing when no goal exists or the RPC is unavailable. `examples/local-tui-adapter.tsx` is a fallback for hosts where the package entry is skipped; do not install it alongside the package.

## Options

Pass options with the object form in the `plugins` entry:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-goal-plugin",
      "options": { "verification": "model", "onUserMessage": "pause" }
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `autoContinue` | `true` | enable automatic continuation at turn boundaries |
| `continuationIntervalMs` | `1500` | delay before each continuation prompt |
| `verification` | `"model"` | `evidence` / `model` completion gate |
| `verifierModel` | session / host default | `"provider/model"` or `{ providerID, id, variant? }`; explicit failures are fail-closed |
| `verifierTimeoutMs` | `300000` | verifier timeout (fail-closed) |
| `onUserMessage` | `"pause"` | `pause` or `continue` when you write mid-goal |
| `maxPromptFailures` | `3` | consecutive continuation prompt failures before pausing (persisted) |
| `debug` | `false` | verbose plugin logging |

## Limitations

- State uses host plugin storage; run a **single OpenCode server per storage database**.
- Evidence candidates are in-memory: after a restart the model must produce fresh successful tool calls before completing.
- The `model` verification tier needs a verifier model that the host allows `generate` calls for; otherwise the goal completes on the evidence gate with a recorded degradation.
- The TUI sidebar renders in the terminal client only (the desktop app does not render CLI plugins) and requires the managed service connection.
- OpenCode 2 plugin APIs are evolving; this package targets `@opencode/plugin` 2.0.22 semantics. Check the host version with `opencode2 --version`.

## Development

The published manifest intentionally has no scripts, devDependencies, or lockfile so git installs skip npm's git-preparation step. Dev tooling lives in `dev/`:

```sh
cd dev && npm install
dev/node_modules/.bin/tsc -p tsconfig.json    # build server/rpc -> dist/
dev/node_modules/.bin/bun dev/build-tui.mjs   # build the TUI sidebar (OpenTUI Solid plugin) -> dist/tui.js
node --test "test/*.test.mjs"                 # unit/integration tests (run after build)
```

`dist/` is committed on purpose. Rebuild and commit it after changing `src/`. The TUI must be built with the `@opentui/solid` Bun plugin; plain esbuild/tsc output imports a private Solid runtime and the widget will not re-render.

## License

MIT
