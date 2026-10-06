/**
 * Goal controller: the only component that touches the live plugin context.
 *
 * Wires commands, tools, hooks, and events to the pure state machine and the
 * continuation loop. Guarantees:
 * - only root sessions in this plugin's project/location drive continuations;
 * - user prompts pause auto-continuation by default (child prompts of the
 *   plugin itself are marked and ignored);
 * - completion is evidence-gated and (by default) independently verified;
 * - limit/rejections are fail-closed with a visible stop reason.
 */

import type {
  CommandInvocation,
  EventLike,
  JsonObject,
  PluginContext,
  PromptAgent,
  PromptFile,
  PromptSkill,
  SessionInfo,
  ToolCallContext,
} from "./api.js";
import { commandHelp, formatHistory, formatStatus, formatTasks, parseGoalCommand } from "./commands.js";
import { EvidenceTracker, evidenceQuality, isProgressTool, summarizeToolResult } from "./evidence.js";
import { ContinuationLoop } from "./loop.js";
import { resolveOptions, type ResolvedOptions } from "./options.js";
import { buildSystemBlock, continuationText, INTERNAL_METADATA_KEY } from "./prompts.js";
import { GoalStore } from "./store.js";
import { GoalRpc } from "./rpc.js";
import {
  accountUsage,
  activeMsAt,
  addTask,
  blockGoal,
  cancelGoal,
  completeGoal,
  editGoal,
  findTask,
  pauseGoal,
  recordCheckpoint,
  resumeGoal,
  startGoal,
  statusLabel,
  taskSummary,
  updateTask,
} from "./state.js";
import { goalToolDefinitions, type GoalSetInput, type GoalUpdateInput } from "./tools.js";
import type { EvidenceCandidate, EvidenceRecord, GoalRecord, UsageSnapshot } from "./types.js";
import { asNumber, asString, errorText, isRecord, makeID, nowIso, truncate } from "./util.js";
import { extractTranscript, verifyCompletion } from "./verify.js";

export const PLUGIN_ID = "opencode-goal";

/** Slash command name. */
const COMMAND_NAME = "goal";

/** Continuations admitted within this window are considered the same turn (cross-instance dedup). */
const CONTINUATION_DEDUP_MS = 10_000;

interface SessionCacheEntry {
  at: number;
  info?: SessionInfo;
}

interface UsageState {
  snapshot?: UsageSnapshot;
}

export class GoalController implements GoalToolApiLike {
  private readonly options: ResolvedOptions;
  private readonly store: GoalStore;
  private readonly candidates = new EvidenceTracker();
  private readonly loop: ContinuationLoop;
  private readonly abort = new AbortController();
  private readonly sessions = new Map<string, SessionCacheEntry>();
  private readonly usageStates = new Map<string, UsageState>();
  private readonly failureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rpcRegistration?: {
    dispose: () => void | Promise<void>;
    events: { emit: (...args: any[]) => Promise<void> };
  };
  private disposed = false;

  constructor(private readonly ctx: PluginContext) {
    this.options = resolveOptions(ctx.options ?? {});
    this.store = new GoalStore(
      ctx.storage,
      {
        projectID: ctx.location.project.id,
        directory: ctx.location.directory,
        workspaceID: ctx.location.workspaceID,
      },
      (sessionID) => this.scheduleGoalUpdate(sessionID),
    );
    this.loop = new ContinuationLoop(
      {
        canContinue: (sessionID) => this.canContinue(sessionID),
        sendContinuation: (sessionID, goal) => this.sendContinuation(sessionID, goal),
        onPromptFailure: (sessionID, error) => this.onPromptFailure(sessionID, error),
        log: (message, data) => this.log(message, data),
      },
      this.options.continuationIntervalMs,
    );
  }

  async start(): Promise<void> {
    await this.registerRpc();
    await this.recover();
    await this.registerCommand();
    await this.registerTools();
    await this.registerHooks();
    this.subscribeEvents();
    this.log(`goal plugin ready for project ${this.ctx.location.project.id}`);
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.loop.dispose();
    for (const timer of this.failureTimers.values()) clearTimeout(timer);
    this.failureTimers.clear();
    for (const timer of this.updateTimers.values()) clearTimeout(timer);
    this.updateTimers.clear();
    this.candidates.clearAll();
    void this.rpcRegistration?.dispose?.();
  }

  // ── RPC (TUI sidebar) ────────────────────────────────────────────────────

  private async registerRpc(): Promise<void> {
    try {
      if (!this.ctx.rpc?.register) return;
      this.rpcRegistration = await this.ctx.rpc.register(GoalRpc, {
        get: async (input: any) => ({ payload: await this.snapshotPayload(asString(input?.sessionID) ?? "") }),
      });
    } catch (error) {
      this.log("rpc registration failed", errorText(error));
    }
  }

  private scheduleGoalUpdate(sessionID: string): void {
    if (!this.rpcRegistration || this.disposed) return;
    const existing = this.updateTimers.get(sessionID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.updateTimers.delete(sessionID);
      void this.rpcRegistration?.events
        .emit("updated", { sessionID })
        .catch((error) => this.log("rpc event failed", errorText(error)));
    }, 80);
    this.updateTimers.set(sessionID, timer);
  }

  private async snapshotPayload(sessionID: string): Promise<string> {
    if (!sessionID) return JSON.stringify({ present: false });
    const info = await this.sessionInfo(sessionID);
    const goal = await this.loadGoalForSession(sessionID, info);
    if (!goal || goal.dismissed) return JSON.stringify({ present: false });
    const now = nowIso();
    return JSON.stringify({
      present: true,
      objective: goal.objective,
      status: goal.status,
      stopReason: goal.stopReason,
      recovered: goal.recovered ?? false,
      used: goal.used,
      activeMs: activeMsAt(goal, now),
      tasks: taskSummary(goal),
      taskItems: (goal.tasks ?? []).slice(0, 8).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
      })),
      evidenceCount: goal.evidence.length,
      updatedAt: goal.updatedAt,
    });
  }

  /**
   * Load a goal using the session's own project/location scope. The TUI/RPC
   * client carries its own default location, which can differ from the
   * session's project (e.g. a goal created in the repo session viewed from a
   * TUI started elsewhere), so the instance store scope cannot be assumed.
   */
  private async loadGoalForSession(
    sessionID: string,
    info: SessionInfo | undefined,
  ): Promise<GoalRecord | undefined> {
    const direct = await this.store.load(sessionID);
    if (direct) return direct;
    const projectID = typeof info?.projectID === "string" ? info.projectID : this.ctx.location.project.id;
    const directory =
      typeof info?.location?.directory === "string" ? info.location.directory : this.ctx.location.directory;
    const workspaceID =
      typeof info?.location?.workspaceID === "string" ? info.location.workspaceID : this.ctx.location.workspaceID;
    if (
      projectID !== this.ctx.location.project.id ||
      directory !== this.ctx.location.directory ||
      workspaceID !== this.ctx.location.workspaceID
    ) {
      const store = new GoalStore(this.ctx.storage, { projectID, directory, workspaceID });
      const scoped = await store.load(sessionID);
      if (scoped) return scoped;
    }
    // Last resort: the location-independent index, then a full scan.
    const indexed = await this.store.loadByIndex(sessionID);
    if (indexed) return indexed;
    return this.store.findBySession(sessionID);
  }

  // ── Cross-instance claim arbitration ─────────────────────────────────────

  /**
   * Best-effort exactly-one arbitration across plugin instances sharing the
   * same storage: every contender writes a nonce, waits, then re-reads; only
   * the value that survived wins. Prevents duplicate continuation prompts
   * when several live plugin instances observe the same boundary (found live:
   * two prompts 2ms apart).
   */
  private async claim(sessionID: string, purpose: string): Promise<boolean> {
    const key = this.store.claimKey(sessionID, purpose);
    const nonce = makeID("claim");
    try {
      await this.ctx.storage.set(key, { nonce, at: Date.now() });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 50));
    try {
      const current = await this.ctx.storage.get(key);
      if (!isRecord(current)) return true;
      return current.nonce === nonce;
    } catch {
      return true;
    }
  }

  private log(message: string, data?: unknown): void {
    if (!this.options.debug && data === undefined) return;
    try {
      console.error(`[${PLUGIN_ID}] ${message}`, data === undefined ? "" : data);
    } catch {
      // never let logging break the plugin
    }
  }

  // ── Session helpers ──────────────────────────────────────────────────────

  private async sessionInfo(sessionID: string): Promise<SessionInfo | undefined> {
    const cached = this.sessions.get(sessionID);
    if (cached && Date.now() - cached.at < 10_000) return cached.info;
    try {
      const info = await this.ctx.session.get({ sessionID });
      this.sessions.set(sessionID, { at: Date.now(), info });
      return info;
    } catch {
      this.sessions.set(sessionID, { at: Date.now(), info: undefined });
      return undefined;
    }
  }

  private async ownsSession(sessionID: string): Promise<boolean> {
    const info = await this.sessionInfo(sessionID);
    if (!info) return false;
    if (info.projectID && info.projectID !== this.ctx.location.project.id) return false;
    const sessionWorkspace = info.location?.workspaceID;
    const pluginWorkspace = this.ctx.location.workspaceID;
    if (sessionWorkspace !== undefined && pluginWorkspace !== undefined && sessionWorkspace !== pluginWorkspace) {
      return false;
    }
    return true;
  }

  private async rootSession(sessionID: string): Promise<string> {
    let current = sessionID;
    for (let depth = 0; depth < 5; depth++) {
      const info = await this.sessionInfo(current);
      const parent = typeof info?.parentID === "string" && info.parentID ? info.parentID : undefined;
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  /** Fallback verifier model from the host's default selection, when available. */
  private async defaultModel(): Promise<{ providerID: string; id: string; variant?: string } | undefined> {
    try {
      const result = await this.ctx.model?.default?.({ location: { directory: this.ctx.location.directory } });
      const info = result?.data;
      if (info && typeof info.providerID === "string" && typeof info.id === "string") {
        return { providerID: info.providerID, id: info.id, ...(typeof info.variant === "string" ? { variant: info.variant } : {}) };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async reply(sessionID: string, text: string): Promise<void> {
    try {
      // Synthetic messages are delivered to the model, not rendered for the
      // user by the TUI, so prefix with a short relay instruction.
      await this.ctx.session.synthetic({
        sessionID,
        text: `Goal command result (relay this to the user):\n\n${text}`,
        description: "goal",
      });
    } catch (error) {
      this.log("could not deliver reply", errorText(error));
    }
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  private async recover(): Promise<void> {
    try {
      const records = await this.store.scan();
      let recovered = 0;
      for (const record of records) {
        // Backfill the location index for records saved before it existed.
        await this.store.ensureIndex(record);
        if (record.status !== "active") continue;
        await this.store.mutate(record.sessionID, (current) => {
          if (!current || current.goalID !== record.goalID || current.status !== "active") return current;
          pauseGoal(current, "recovered after restart; run /goal resume to continue", nowIso());
          current.recovered = true;
          return current;
        });
        recovered += 1;
      }
      if (recovered > 0) this.log(`recovered ${recovered} active goal(s) into paused state`);
    } catch (error) {
      this.log("goal recovery scan failed", errorText(error));
    }
  }

  // ── Registration ─────────────────────────────────────────────────────────

  private async registerCommand(): Promise<void> {
    const name = COMMAND_NAME;
    try {
      await this.ctx.command.transform((editor) => {
        editor.add({
          name,
          description: "Set and manage a persistent session goal with evidence-gated completion",
          execute: (input) => this.handleCommand(input),
        });
      });
    } catch (error) {
      this.log("command registration failed", errorText(error));
    }
  }

  private async registerTools(): Promise<void> {
    try {
      const tools = goalToolDefinitions(this);
      await this.ctx.tool.transform((editor) => {
        for (const tool of tools) editor.add(tool);
      });
    } catch (error) {
      this.log("tool registration failed", errorText(error));
    }
  }

  private async registerHooks(): Promise<void> {
    try {
      await this.ctx.session.hook("context", (event: any) => this.onContextHook(event));
    } catch (error) {
      this.log("context hook registration failed", errorText(error));
    }
    try {
      await this.ctx.session.hook("prompt", (event: any) => this.onPromptHook(event));
    } catch (error) {
      this.log("prompt hook registration failed", errorText(error));
    }
    try {
      await this.ctx.session.hook("compaction", (event: any) => this.onCompactionHook(event));
    } catch (error) {
      this.log("compaction hook registration failed", errorText(error));
    }
    try {
      await this.ctx.tool.hook("execute.after", (event: any) => this.onToolExecuted(event));
    } catch (error) {
      this.log("tool hook registration failed", errorText(error));
    }
  }

  // ── Hooks ────────────────────────────────────────────────────────────────

  private async onContextHook(event: any): Promise<void> {
    const sessionID = asString(event?.sessionID);
    if (!sessionID || !Array.isArray(event?.system)) return;
    const root = await this.rootSession(sessionID);
    const goal = await this.store.load(root);
    if (!goal) return;
    const block = buildSystemBlock(goal, {
      candidates: this.candidates.list(root),
      delegated: root !== sessionID,
      maxChars: 4_000,
    });
    if (!block) return;
    event.system.push({ type: "text", text: block, metadata: { plugin: PLUGIN_ID } });
  }

  private async onCompactionHook(event: any): Promise<void> {
    const sessionID = asString(event?.sessionID);
    if (!sessionID || !Array.isArray(event?.system)) return;
    const root = await this.rootSession(sessionID);
    const goal = await this.store.load(root);
    if (!goal || goal.status === "complete" || goal.status === "cancelled") return;
    const summary = taskSummary(goal);
    const line = `[opencode-goal] Persist this goal through compaction: ${goal.objective} (status: ${goal.status}${
      summary.total ? `, tasks ${summary.done}/${summary.total} done` : ""
    }).`;
    event.system.push({ type: "text", text: line, metadata: { plugin: PLUGIN_ID } });
  }

  private async onPromptHook(event: any): Promise<void> {
    const sessionID = asString(event?.sessionID);
    if (!sessionID) return;
    const metadata = event?.metadata;
    if (isRecord(metadata) && metadata[INTERNAL_METADATA_KEY] === true) return;
    if (!(await this.ownsSession(sessionID))) return;
    const goal = await this.store.load(sessionID);
    if (!goal || goal.status !== "active") return;

    if (this.options.onUserMessage === "continue") {
      // Hands control back to the user for this turn; the turn boundary
      // schedules the next continuation once the turn settles.
      this.loop.cancel(sessionID);
      return;
    }
    await this.store.mutate(sessionID, (current) => {
      if (current && current.status === "active") pauseGoal(current, "user message", nowIso());
      return current;
    });
    this.loop.cancel(sessionID);
  }

  private async onToolExecuted(event: any): Promise<void> {
    if (event?.status !== "completed") return;
    const sessionID = asString(event?.sessionID);
    const tool = asString(event?.tool);
    const callID = asString(event?.id);
    if (!sessionID || !tool || !callID) return;
    if (tool.startsWith("goal_")) return;
    if (!(await this.ownsSession(sessionID))) return;

    const root = await this.rootSession(sessionID);
    const goal = await this.store.load(root);
    if (!goal || goal.status !== "active") return;

    const candidate: EvidenceCandidate = {
      callID,
      tool,
      summary: summarizeToolResult(tool, event?.result),
      at: nowIso(),
      messageID: asString(event?.messageID),
      progress: isProgressTool(tool),
    };
    this.candidates.record(root, candidate);
    await this.store.mutate(root, (current) => {
      if (current && current.status === "active") {
        recordCheckpoint(current, {
          at: candidate.at,
          tool,
          callID,
          summary: candidate.summary,
          progress: candidate.progress,
        });
      }
      return current;
    });
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private subscribeEvents(): void {
    try {
      const stream = this.ctx.event.subscribe({ signal: this.abort.signal });
      void (async () => {
        try {
          for await (const event of stream) {
            if (this.disposed) break;
            try {
              await this.onEvent(event);
            } catch (error) {
              this.log("event handler failed", { type: event?.type, error: errorText(error) });
            }
          }
        } catch (error) {
          if (!this.disposed) this.log("event stream ended", errorText(error));
        }
      })();
    } catch (error) {
      this.log("event subscription failed", errorText(error));
    }
  }

  private async onEvent(event: EventLike): Promise<void> {
    const sessionID = asString(event?.data?.sessionID);
    if (!sessionID) return;

    switch (event.type) {
      case "session.execution.started": {
        if (!(await this.ownsSession(sessionID))) return;
        this.clearFailureTimer(sessionID);
        this.loop.noteExecutionStarted(sessionID);
        return;
      }
      case "session.execution.succeeded": {
        if (!(await this.ownsSession(sessionID))) return;
        this.clearFailureTimer(sessionID);
        const boundary = this.loop.noteBoundary(sessionID, asString(event.id), "execution");
        if (boundary.duplicate) return;
        await this.loop.schedule(sessionID);
        return;
      }
      case "session.execution.failed": {
        if (!(await this.ownsSession(sessionID))) return;
        const retrying = this.loop.isRetrying(sessionID);
        this.loop.noteFailure(sessionID);
        if (retrying) return;
        const detail = this.failureDetail(event);
        this.scheduleFailurePause(sessionID, detail);
        return;
      }
      case "session.execution.interrupted": {
        if (!(await this.ownsSession(sessionID))) return;
        this.clearFailureTimer(sessionID);
        this.loop.noteFailure(sessionID);
        const reason = asString(event.data?.reason) ?? "unknown";
        if (reason !== "user") return;
        await this.mutateActive(sessionID, (goal) => {
          pauseGoal(goal, "interrupted by user", nowIso());
        });
        return;
      }
      case "session.retry.scheduled": {
        if (!(await this.ownsSession(sessionID))) return;
        this.clearFailureTimer(sessionID);
        this.loop.noteRetryScheduled(sessionID);
        return;
      }
      case "session.idle": {
        if (!(await this.ownsSession(sessionID))) return;
        if (this.loop.isRetrying(sessionID)) return;
        const boundary = this.loop.noteBoundary(sessionID, asString(event.id), "idle");
        if (boundary.duplicate) return;
        await this.loop.schedule(sessionID);
        return;
      }
      case "session.usage.updated": {
        await this.onUsage(sessionID, event);
        return;
      }
      case "session.compaction.started": {
        this.loop.noteCompaction(sessionID, true);
        return;
      }
      case "session.compaction.ended": {
        this.loop.noteCompaction(sessionID, false);
        void this.loop.schedule(sessionID);
        return;
      }
      case "session.moved":
      case "session.deleted": {
        this.loop.cancel(sessionID);
        this.candidates.clear(sessionID);
        this.clearFailureTimer(sessionID);
        return;
      }
      default:
        return;
    }
  }

  private failureDetail(event: EventLike): string {
    const error = event.data?.error;
    if (isRecord(error)) {
      const message = asString(error.message);
      if (message) return truncate(message, 200);
    }
    return "execution failed";
  }

  private scheduleFailurePause(sessionID: string, detail: string): void {
    // `session.execution.failed` may be followed by an automatic retry. Pause
    // only when no retry/restart arrives within the grace window.
    const existing = this.failureTimers.get(sessionID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.failureTimers.delete(sessionID);
      void this.mutateActive(sessionID, (goal) => {
        pauseGoal(goal, `execution failed: ${detail}`, nowIso());
      });
    }, 2_500);
    this.failureTimers.set(sessionID, timer);
  }

  private clearFailureTimer(sessionID: string): void {
    const timer = this.failureTimers.get(sessionID);
    if (timer) clearTimeout(timer);
    this.failureTimers.delete(sessionID);
  }

  private async mutateActive(
    sessionID: string,
    mutate: (goal: GoalRecord) => void,
  ): Promise<GoalRecord | undefined> {
    return this.store.mutate(sessionID, (current) => {
      if (current && current.status === "active") mutate(current);
      return current;
    });
  }

  private async onUsage(sessionID: string, event: EventLike): Promise<void> {
    const tokens = isRecord(event.data?.tokens) ? event.data.tokens : undefined;
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    const snapshot: UsageSnapshot = {
      input: asNumber(tokens?.input) ?? 0,
      output: asNumber(tokens?.output) ?? 0,
      reasoning: asNumber(tokens?.reasoning) ?? 0,
      cacheRead: asNumber(cache?.read) ?? 0,
      cacheWrite: asNumber(cache?.write) ?? 0,
      cost: asNumber(event.data?.cost) ?? 0,
    };

    const root = await this.rootSession(sessionID);
    if (root !== sessionID) return;
    const goal = await this.store.load(sessionID);

    const state = this.usageState(sessionID);
    // `usage.updated` carries cumulative session totals. Diff against the
    // previous snapshot (in memory, or the persisted one after a restart) to
    // recover the latest call's own usage, which is the real context size.
    const previous = state.snapshot ?? goal?.lastUsage;
    const call: UsageSnapshot | undefined = previous
      ? {
          input: Math.max(0, snapshot.input - previous.input),
          output: Math.max(0, snapshot.output - previous.output),
          reasoning: Math.max(0, snapshot.reasoning - previous.reasoning),
          cacheRead: Math.max(0, snapshot.cacheRead - previous.cacheRead),
          cacheWrite: Math.max(0, snapshot.cacheWrite - previous.cacheWrite),
          cost: Math.max(0, snapshot.cost - previous.cost),
        }
      : undefined;
    state.snapshot = snapshot;

    if (!goal) return;
    await this.store.mutate(sessionID, (current) => {
      if (current) accountUsage(current, snapshot, call);
      return current;
    });
  }

  private usageState(sessionID: string): UsageState {
    let state = this.usageStates.get(sessionID);
    if (!state) {
      state = {};
      this.usageStates.set(sessionID, state);
    }
    return state;
  }

  // ── Continuation loop integration ────────────────────────────────────────

  private async canContinue(sessionID: string): Promise<GoalRecord | undefined> {
    if (!this.options.autoContinue) return undefined;
    if (!(await this.ownsSession(sessionID))) return undefined;
    const info = await this.sessionInfo(sessionID);
    if (info?.parentID) return undefined;
    const goal = await this.store.load(sessionID);
    if (!goal || goal.status !== "active") return undefined;
    return goal;
  }

  private async sendContinuation(sessionID: string, goal: GoalRecord): Promise<boolean> {
    const fresh = await this.store.load(sessionID);
    if (!fresh || fresh.goalID !== goal.goalID || fresh.status !== "active") return false;
    // Cross-instance / cross-turn dedup: a continuation admitted within the
    // window is authoritative; another instance already sent it.
    if (fresh.lastContinuationAt && Date.now() - fresh.lastContinuationAt < CONTINUATION_DEDUP_MS) return false;
    if (!(await this.claim(sessionID, "continuation"))) return false;
    const still = await this.store.load(sessionID);
    if (!still || still.goalID !== goal.goalID || still.status !== "active") return false;

    await this.ctx.session.prompt({
      sessionID,
      text: continuationText(goal),
      metadata: { [INTERNAL_METADATA_KEY]: true },
    });
    await this.store.mutate(sessionID, (current) => {
      if (current && current.goalID === goal.goalID && current.status === "active") {
        current.used.turns += 1;
        current.promptFailures = 0;
        current.lastContinuationAt = Date.now();
        current.updatedAt = nowIso();
      }
      return current;
    });
    return true;
  }

  private async onPromptFailure(sessionID: string, error: unknown): Promise<void> {
    const updated = await this.store.mutate(sessionID, (current) => {
      if (current && current.status === "active") {
        current.promptFailures = (current.promptFailures ?? 0) + 1;
      }
      return current;
    });
    const failures = updated?.promptFailures ?? 0;
    if (failures < this.options.maxPromptFailures) return;
    await this.mutateActive(sessionID, (goal) => {
      pauseGoal(goal, `continuation prompt failed ${failures} times: ${errorText(error)}`, nowIso());
    });
  }

  // ── Command handling ─────────────────────────────────────────────────────

  private async handleCommand(input: CommandInvocation): Promise<void> {
    const sessionID = input.sessionID;
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) {
      await this.reply(sessionID, "Goals belong to the main session; run the goal command there.");
      return;
    }
    const raw = input.prompt?.text ?? "";
    const parsed = parseGoalCommand(raw);
    if (parsed.error) {
      await this.reply(sessionID, `⚠️ ${parsed.error}\n\n${commandHelp(COMMAND_NAME)}`);
      return;
    }

    switch (parsed.verb) {
      case "status": {
        const goal = await this.store.load(sessionID);
        await this.reply(sessionID, formatStatus(goal, this.candidates.list(sessionID)));
        return;
      }
      case "help": {
        await this.reply(sessionID, commandHelp(COMMAND_NAME));
        return;
      }
      case "history": {
        const goal = await this.store.load(sessionID);
        await this.reply(sessionID, formatHistory(goal));
        return;
      }
      case "task": {
        await this.handleTaskCommand(sessionID, parsed.text);
        return;
      }
      case "set": {
        await this.startGoalFromCommand(sessionID, parsed.text, parsed.flags, input);
        return;
      }
      case "pause": {
        const updated = await this.mutateActive(sessionID, (goal) => pauseGoal(goal, "paused by user", nowIso()));
        this.loop.cancel(sessionID);
        await this.reply(
          sessionID,
          updated ? `⏸ Goal paused.\n${formatStatus(updated, this.candidates.list(sessionID))}` : "No active goal to pause.",
        );
        return;
      }
      case "resume": {
        const updated = await this.store.mutate(sessionID, (current) => {
          if (current) resumeGoal(current, nowIso());
          return current;
        });
        await this.reply(
          sessionID,
          updated ? `▶️ Goal resumed.\n${formatStatus(updated, this.candidates.list(sessionID))}` : "No goal to resume.",
        );
        if (updated?.status === "active") void this.loop.schedule(sessionID);
        return;
      }
      case "edit": {
        const objective = parsed.text.trim();
        if (!objective) {
          await this.reply(sessionID, "Usage: /goal edit <new objective>");
          return;
        }
        const updated = await this.store.mutate(sessionID, (current) => {
          if (current && current.status !== "complete" && current.status !== "cancelled") {
            editGoal(current, objective, nowIso());
          }
          return current;
        });
        await this.reply(sessionID, updated ? `✏️ Goal objective updated.` : "No goal to edit.");
        return;
      }
      case "block": {
        const reason = parsed.text.trim();
        if (!reason) {
          await this.reply(sessionID, "Usage: /goal block <specific reason>");
          return;
        }
        const updated = await this.store.mutate(sessionID, (current) => {
          if (current) blockGoal(current, reason, nowIso());
          return current;
        });
        this.loop.cancel(sessionID);
        await this.reply(sessionID, updated ? `🚧 Goal blocked: ${reason}` : "No goal to block.");
        return;
      }
      case "done": {
        const summary = parsed.text.trim();
        const candidate = this.candidates.latest(sessionID);
        const result = await this.completeWithEvidence(sessionID, summary, candidate?.callID);
        await this.reply(sessionID, result.message);
        return;
      }
      case "clear": {
        const state: { outcome: "none" | "cleared" | "dismissed" } = { outcome: "none" };
        const updated = await this.store.mutate(sessionID, (current) => {
          if (!current) return current;
          if (current.status === "complete" || current.status === "cancelled") {
            // Already terminal: just hide it from the sidebar, keep history.
            current.dismissed = true;
            current.updatedAt = nowIso();
            state.outcome = "dismissed";
            return current;
          }
          cancelGoal(current, "cleared by user", nowIso());
          current.dismissed = true;
          state.outcome = "cleared";
          return current;
        });
        this.loop.cancel(sessionID);
        this.candidates.clear(sessionID);
        await this.reply(
          sessionID,
          state.outcome === "cleared"
            ? "🧹 Goal cleared."
            : state.outcome === "dismissed"
              ? `🧹 Removed the ${updated?.status ?? "closed"} goal from the sidebar (history is still available via /goal history).`
              : "No goal to clear.",
        );
        return;
      }
      default:
        await this.reply(sessionID, commandHelp(COMMAND_NAME));
        return;
    }
  }

  private async handleTaskCommand(sessionID: string, text: string): Promise<void> {
    const rest = text.trim();
    const statuses = new Set(["todo", "doing", "done"]);

    if (!rest || rest.toLowerCase() === "list") {
      const goal = await this.store.load(sessionID);
      await this.reply(sessionID, formatTasks(goal));
      return;
    }

    const parts = rest.split(/\s+/);
    const head = parts[0].toLowerCase();

    if (head === "add") {
      const title = rest.slice(rest.indexOf("add") + 3).trim();
      if (!title) {
        await this.reply(sessionID, "Usage: /goal task add <title>");
        return;
      }
      const result: { task?: string } = {};
      await this.store.mutate(sessionID, (current) => {
        if (current) {
          const task = addTask(current, title, nowIso());
          if (task) result.task = `${task.id}: ${task.title}`;
        }
        return current;
      });
      await this.reply(sessionID, result.task ? `Added ${result.task}` : "No editable goal to add tasks to.");
      return;
    }

    let ref: string | undefined;
    let status: "todo" | "doing" | "done" | undefined;
    if (statuses.has(head) && parts[1]) {
      status = head as "todo" | "doing" | "done";
      ref = parts[1];
    } else if (parts[1] && statuses.has(parts[1].toLowerCase())) {
      ref = head;
      status = parts[1].toLowerCase() as "todo" | "doing" | "done";
    }
    if (!ref || !status) {
      await this.reply(sessionID, "Usage: /goal task <ref> todo|doing|done  (ref = id or number)");
      return;
    }
    const result: { message?: string } = {};
    await this.store.mutate(sessionID, (current) => {
      if (current) {
        const task = updateTask(current, ref!, status!, nowIso());
        result.message = task ? `${task.id} → ${task.status}: ${task.title}` : `Task "${ref}" not found.`;
      }
      return current;
    });
    await this.reply(sessionID, result.message ?? "No goal to update.");
  }

  private async startGoalFromCommand(
    sessionID: string,
    objective: string,
    flags: { criteria?: string; constraints?: string; verification?: "evidence" | "model" },
    invocation: CommandInvocation,
  ): Promise<void> {
    const text = objective.trim();
    if (!text) {
      await this.reply(sessionID, commandHelp(COMMAND_NAME));
      return;
    }
    const goal = await this.createGoal(sessionID, {
      objective: text,
      criteria: flags.criteria,
      constraints: flags.constraints,
      verification: flags.verification,
    });
    this.candidates.clear(sessionID);
    await this.reply(
      sessionID,
      `🎯 Goal started.\n${formatStatus(goal, this.candidates.list(sessionID))}`,
    );
    try {
      await this.ctx.session.prompt({
        sessionID,
        text,
        files: invocation.prompt?.files as PromptFile[] | undefined,
        agents: invocation.prompt?.agents as PromptAgent[] | undefined,
        skills: invocation.prompt?.skills as PromptSkill[] | undefined,
        metadata: { [INTERNAL_METADATA_KEY]: true },
        delivery: invocation.delivery,
      });
    } catch (error) {
      await this.reply(sessionID, `Goal saved, but the starting prompt failed: ${errorText(error)}`);
    }
  }

  private async createGoal(
    sessionID: string,
    input: {
      objective: string;
      criteria?: string;
      constraints?: string;
      verification?: "evidence" | "model";
    },
  ): Promise<GoalRecord> {
    const at = nowIso();
    const baseUsage = this.usageState(sessionID).snapshot;
    const record = await this.store.mutate(sessionID, (previous) =>
      startGoal(previous, {
        sessionID,
        projectID: this.ctx.location.project.id,
        locationDirectory: this.ctx.location.directory,
        workspaceID: this.ctx.location.workspaceID,
        objective: input.objective,
        criteria: input.criteria,
        constraints: input.constraints,
        at,
        baseUsage,
        verification: input.verification,
      }),
    );
    return record as GoalRecord;
  }

  // ── Tool API implementation ──────────────────────────────────────────────

  async goalStatusJSON(sessionID: string): Promise<string> {
    const root = await this.rootSession(sessionID);
    const goal = await this.store.load(root);
    const candidates = this.candidates.list(root).map((candidate) => ({
      callID: candidate.callID,
      tool: candidate.tool,
      summary: candidate.summary,
      at: candidate.at,
    }));
    if (!goal) {
      return JSON.stringify({ goal: null, evidenceCandidates: [], note: "No goal set for this session." }, null, 2);
    }
    const now = nowIso();
    return JSON.stringify(
      {
        goal: {
          goalID: goal.goalID,
          objective: goal.objective,
          criteria: goal.criteria,
          constraints: goal.constraints,
          status: goal.status,
          stopReason: goal.stopReason,
          recovered: goal.recovered ?? false,
          used: goal.used,
          activeMs: activeMsAt(goal, now),
          tasks: goal.tasks,
          taskSummary: taskSummary(goal),
          checkpoints: goal.checkpoints.slice(-5),
          history: goal.history.slice(-10),
          archive: goal.archive.map((archived) => ({
            objective: archived.objective,
            status: archived.status,
            stopReason: archived.stopReason,
          })),
          evidence: goal.evidence,
        },
        evidenceCandidates: candidates,
        instruction:
          candidates.length > 0
            ? 'To complete, call goal_update with action "complete" and evidence { candidateID: <exact ID>, summary: <specific checkable summary> }.'
            : "No valid evidence candidates yet. Run a verification tool (tests/build) successfully, then call goal_get again.",
      },
      null,
      2,
    );
  }

  async goalHistoryJSON(sessionID: string): Promise<string> {
    const root = await this.rootSession(sessionID);
    const goal = await this.store.load(root);
    if (!goal) return JSON.stringify({ goal: null, history: [], archive: [] });
    return JSON.stringify(
      {
        goal: { goalID: goal.goalID, objective: goal.objective, status: goal.status, stopReason: goal.stopReason },
        history: goal.history.slice(-30),
        archive: goal.archive,
      },
      null,
      2,
    );
  }

  async goalSet(sessionID: string, input: GoalSetInput): Promise<{ ok: boolean; message: string }> {
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) {
      return { ok: false, message: "Subagents cannot create goals; only the main session can." };
    }
    const existing = await this.store.load(sessionID);
    if (existing && existing.status !== "complete" && existing.status !== "cancelled") {
      return {
        ok: false,
        message: `A goal already exists (${statusLabel(existing)}). Update it with goal_update or ask the user to clear it first.`,
      };
    }
    const objective = (input.objective ?? "").trim();
    if (!objective) return { ok: false, message: "objective is required." };
    const goal = await this.createGoal(sessionID, {
      objective,
      criteria: input.criteria,
      constraints: input.constraints,
    });
    this.candidates.clear(sessionID);
    return { ok: true, message: `Goal created: ${goal.objective}` };
  }

  async goalUpdate(sessionID: string, input: GoalUpdateInput): Promise<{ ok: boolean; message: string }> {
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) {
      return { ok: false, message: "Subagents cannot update the goal; report findings to the main session instead." };
    }
    switch (input.action) {
      case "pause": {
        const updated = await this.mutateActive(sessionID, (goal) => pauseGoal(goal, "paused by agent", nowIso()));
        this.loop.cancel(sessionID);
        return updated
          ? { ok: true, message: `Goal paused: ${updated.objective}` }
          : { ok: false, message: "No active goal to pause." };
      }
      case "resume": {
        const updated = await this.store.mutate(sessionID, (current) => {
          if (current) resumeGoal(current, nowIso());
          return current;
        });
        if (updated?.status === "active") void this.loop.schedule(sessionID);
        return updated
          ? { ok: true, message: `Goal resumed: ${updated.objective}` }
          : { ok: false, message: "No goal to resume." };
      }
      case "block": {
        const blocker = (input.blocker ?? "").trim();
        if (!blocker) return { ok: false, message: "A specific blocker is required." };
        const updated = await this.store.mutate(sessionID, (current) => {
          if (current) blockGoal(current, blocker, nowIso());
          return current;
        });
        this.loop.cancel(sessionID);
        return updated
          ? { ok: true, message: `Goal blocked: ${blocker}` }
          : { ok: false, message: "No goal to block." };
      }
      case "complete": {
        return this.completeWithEvidence(sessionID, (input.evidence?.summary ?? "").trim(), input.evidence?.candidateID);
      }
      default:
        return { ok: false, message: `Unknown action "${String(input.action)}".` };
    }
  }

  async goalClear(sessionID: string): Promise<{ ok: boolean; message: string }> {
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) return { ok: false, message: "Subagents cannot clear goals." };
    return {
      ok: false,
      message: "Clearing a goal is reserved for the user. Ask the user to run /goal clear.",
    };
  }

  async goalTaskAdd(sessionID: string, title: string): Promise<{ ok: boolean; message: string }> {
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) return { ok: false, message: "Subagents cannot modify the goal task list." };
    const clean = (title ?? "").trim();
    if (!clean) return { ok: false, message: "A task title is required." };
    const result: { added?: string; reason?: string } = {};
    await this.store.mutate(sessionID, (current) => {
      if (!current) return current;
      const task = addTask(current, clean, nowIso());
      if (task) result.added = `${task.id}: ${task.title}`;
      else result.reason = "This goal is closed or the task list is full.";
      return current;
    });
    return result.added
      ? { ok: true, message: `Added task ${result.added}` }
      : { ok: false, message: result.reason ?? "No goal to add tasks to." };
  }

  async goalTaskUpdate(
    sessionID: string,
    ref: string,
    status: "todo" | "doing" | "done",
  ): Promise<{ ok: boolean; message: string }> {
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) return { ok: false, message: "Subagents cannot modify the goal task list." };
    if (status !== "todo" && status !== "doing" && status !== "done") {
      return { ok: false, message: "status must be todo, doing, or done." };
    }
    const result: { message?: string } = {};
    await this.store.mutate(sessionID, (current) => {
      if (!current) return current;
      const task = updateTask(current, ref, status, nowIso());
      result.message = task ? `Task ${task.id} → ${task.status}: ${task.title}` : `Task "${ref}" not found.`;
      return current;
    });
    return result.message
      ? { ok: !result.message.includes("not found"), message: result.message }
      : { ok: false, message: "No goal to update." };
  }

  // ── Completion with verification ─────────────────────────────────────────

  private async completeWithEvidence(
    sessionID: string,
    summary: string,
    candidateID: string | undefined,
  ): Promise<{ ok: boolean; message: string }> {
    const root = await this.rootSession(sessionID);
    if (root !== sessionID) {
      return { ok: false, message: "Only the main session can complete the goal." };
    }
    const goal = await this.store.load(sessionID);
    if (!goal) return { ok: false, message: "No goal is set for this session." };
    if (goal.status !== "active") {
      return {
        ok: false,
        message: `Goal is ${statusLabel(goal)}; resume it before completing.`,
      };
    }
    if (!candidateID) {
      return {
        ok: false,
        message:
          "Completion requires evidence.candidateID from goal_get. Run a verification tool (tests/build) successfully, then read the exact IDs from goal_get.",
      };
    }
    const candidate = this.candidates.list(sessionID).find((item) => item.callID === candidateID);
    if (!candidate) {
      return {
        ok: false,
        message: `Evidence candidate "${candidateID}" is not valid for this session. Call goal_get for the exact candidate IDs.`,
      };
    }
    const quality = evidenceQuality(summary);
    if (quality) {
      return { ok: false, message: `Completion rejected: ${quality}.` };
    }

    let transcript = "";
    try {
      transcript = extractTranscript(await this.ctx.session.context({ sessionID }), 8_000);
    } catch {
      transcript = "";
    }
    const info = await this.sessionInfo(sessionID);
    const model = info?.model;
    const sessionModel =
      model && typeof model.providerID === "string" && typeof model.id === "string"
        ? { providerID: model.providerID, id: model.id, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) }
        : undefined;
    const explicitVerifier = this.options.verifierModel;
    const verifierModel = explicitVerifier ?? sessionModel ?? (await this.defaultModel());

    const decision = await verifyCompletion(
      this.ctx,
      goal.verification ?? this.options.verification,
      this.options.verifierTimeoutMs,
      { goal, candidate, summary, transcript, verifierModel, verifierExplicit: Boolean(explicitVerifier) },
    );

    if (!decision.approved) {
      await this.mutateActive(sessionID, (current) => {
        pauseGoal(current, `completion rejected (${decision.tier}): ${decision.reason}`, nowIso());
      });
      return {
        ok: false,
        message: `Completion rejected by ${decision.tier} verification: ${decision.reason}. The goal is paused; address the gap and resume.`,
      };
    }

    const record: EvidenceRecord = {
      at: nowIso(),
      candidateID,
      tool: candidate.tool,
      summary,
      tier: decision.tier,
      reason: decision.reason,
    };
    await this.store.mutate(sessionID, (current) => {
      if (current && current.status === "active") completeGoal(current, record, nowIso());
      return current;
    });
    this.candidates.clear(sessionID);
    this.loop.cancel(sessionID);
    return { ok: true, message: `✅ Goal completed (${decision.tier} verification): ${decision.reason}` };
  }
}

/** Local structural alias so the controller can satisfy the tool API without circular imports. */
interface GoalToolApiLike {
  goalStatusJSON(sessionID: string): Promise<string>;
  goalHistoryJSON(sessionID: string): Promise<string>;
  goalSet(sessionID: string, input: GoalSetInput): Promise<{ ok: boolean; message: string }>;
  goalUpdate(sessionID: string, input: GoalUpdateInput): Promise<{ ok: boolean; message: string }>;
  goalClear(sessionID: string): Promise<{ ok: boolean; message: string }>;
  goalTaskAdd(sessionID: string, title: string): Promise<{ ok: boolean; message: string }>;
  goalTaskUpdate(sessionID: string, ref: string, status: "todo" | "doing" | "done"): Promise<{ ok: boolean; message: string }>;
}
