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
import { commandHelp, formatHistory, formatStatus, mergeLimits, parseGoalCommand } from "./commands.js";
import { EvidenceTracker, evidenceQuality, isProgressTool, summarizeToolResult } from "./evidence.js";
import { ContinuationLoop } from "./loop.js";
import { resolveOptions, type ResolvedOptions } from "./options.js";
import { buildSystemBlock, continuationText, INTERNAL_METADATA_KEY, wrapUpText } from "./prompts.js";
import { GoalStore } from "./store.js";
import {
  accountUsage,
  activeMsAt,
  blockGoal,
  completeGoal,
  editGoal,
  limitGoal,
  pauseGoal,
  pushHistory,
  recordCheckpoint,
  resumeGoal,
  settleTurn,
  startGoal,
  statusLabel,
} from "./state.js";
import { goalToolDefinitions, type GoalSetInput, type GoalUpdateInput } from "./tools.js";
import type { EvidenceCandidate, EvidenceRecord, GoalRecord, GoalStatus, UsageSnapshot } from "./types.js";
import { asNumber, asString, errorText, isRecord, nowIso, truncate } from "./util.js";
import { extractTranscript, verifyCompletion } from "./verify.js";

export const PLUGIN_ID = "opencode-goal";

interface SessionCacheEntry {
  at: number;
  info?: SessionInfo;
}

interface UsageState {
  snapshot?: UsageSnapshot;
  /** Output tokens accumulated since the last turn boundary. */
  pendingOutput: number;
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
  private readonly wrapUpSent = new Set<string>();
  private disposed = false;

  constructor(private readonly ctx: PluginContext) {
    this.options = resolveOptions(ctx.options ?? {});
    this.store = new GoalStore(ctx.storage, {
      projectID: ctx.location.project.id,
      directory: ctx.location.directory,
      workspaceID: ctx.location.workspaceID,
    });
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
    this.candidates.clearAll();
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
    const name = this.options.commandName;
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
      maxChars: this.options.contextInjectionMaxChars,
    });
    if (!block) return;
    event.system.push({ type: "text", text: block, metadata: { plugin: PLUGIN_ID } });
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
    this.loop.noteToolCall(root);
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
        await this.onBoundary(sessionID, boundary.wasGoalTurn, boundary.hadToolCall);
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
        this.clearFailureTimer(sessionID);
        this.loop.noteRetryScheduled(sessionID);
        return;
      }
      case "session.idle": {
        if (!(await this.ownsSession(sessionID))) return;
        if (this.loop.isRetrying(sessionID)) return;
        const boundary = this.loop.noteBoundary(sessionID, asString(event.id), "idle");
        if (boundary.duplicate) return;
        await this.onBoundary(sessionID, boundary.wasGoalTurn, boundary.hadToolCall);
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
    const state = this.usageState(sessionID);
    if (state.snapshot) {
      state.pendingOutput += Math.max(0, snapshot.output - state.snapshot.output);
    }
    state.snapshot = snapshot;

    const root = await this.rootSession(sessionID);
    if (root !== sessionID) return;
    const goal = await this.store.load(sessionID);
    if (!goal) return;
    await this.store.mutate(sessionID, (current) => {
      if (current) accountUsage(current, snapshot);
      return current;
    });
  }

  private usageState(sessionID: string): UsageState {
    let state = this.usageStates.get(sessionID);
    if (!state) {
      state = { pendingOutput: 0 };
      this.usageStates.set(sessionID, state);
    }
    return state;
  }

  private consumePendingOutput(sessionID: string): number {
    const state = this.usageState(sessionID);
    const value = state.pendingOutput;
    state.pendingOutput = 0;
    return value;
  }

  // ── Boundary handling ────────────────────────────────────────────────────

  private async onBoundary(sessionID: string, wasGoalTurn: boolean, hadToolCall: boolean): Promise<void> {
    const goal = await this.store.load(sessionID);
    if (!goal) return;

    if (goal.status !== "active") return;

    const outputDelta = this.consumePendingOutput(sessionID);
    let verdict: { status: GoalStatus; reason: string } | undefined;
    const updated = await this.store.mutate(sessionID, (current) => {
      if (!current || current.status !== "active") return current;
      verdict = settleTurn(current, {
        wasGoalTurn,
        hadToolCall,
        outputDelta,
        at: nowIso(),
        stallOutputTokens: this.options.stallOutputTokens,
      });
      if (verdict) {
        limitGoal(current, verdict.status, verdict.reason, nowIso());
      }
      return current;
    });

    if (verdict && updated) {
      this.loop.cancel(sessionID);
      if (this.options.wrapUpOnLimit) await this.sendWrapUp(sessionID, updated);
      return;
    }
    await this.loop.schedule(sessionID);
  }

  private async sendWrapUp(sessionID: string, goal: GoalRecord): Promise<void> {
    if (this.wrapUpSent.has(goal.goalID)) return;
    this.wrapUpSent.add(goal.goalID);
    try {
      await this.ctx.session.prompt({
        sessionID,
        text: wrapUpText(goal),
        metadata: { [INTERNAL_METADATA_KEY]: true },
      });
      await this.store.mutate(sessionID, (current) => {
        if (current && current.goalID === goal.goalID) {
          pushHistory(current, "wrap-up", current.status, current.status, goal.stopReason);
        }
        return current;
      });
    } catch (error) {
      this.log("wrap-up prompt failed", errorText(error));
    }
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

  private async sendContinuation(sessionID: string, goal: GoalRecord): Promise<void> {
    await this.ctx.session.prompt({
      sessionID,
      text: continuationText(goal),
      metadata: { [INTERNAL_METADATA_KEY]: true },
    });
    await this.store.mutate(sessionID, (current) => {
      if (current && current.goalID === goal.goalID && current.status === "active") {
        current.used.turns += 1;
        current.updatedAt = nowIso();
      }
      return current;
    });
  }

  private async onPromptFailure(sessionID: string, error: unknown): Promise<void> {
    const failures = this.loop.notePromptFailure(sessionID);
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
      await this.reply(sessionID, `⚠️ ${parsed.error}\n\n${commandHelp(this.options.commandName)}`);
      return;
    }

    switch (parsed.verb) {
      case "status": {
        const goal = await this.store.load(sessionID);
        await this.reply(sessionID, formatStatus(goal, this.candidates.list(sessionID)));
        return;
      }
      case "help": {
        await this.reply(sessionID, commandHelp(this.options.commandName));
        return;
      }
      case "history": {
        const goal = await this.store.load(sessionID);
        await this.reply(sessionID, formatHistory(goal));
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
        const updated = await this.store.mutate(sessionID, (current) => {
          if (current && current.status !== "complete" && current.status !== "cancelled") {
            pauseGoal(current, "cleared by user", nowIso());
          }
          return current;
        });
        if (updated && updated.status !== "complete") {
          await this.store.mutate(sessionID, (current) => {
            if (current) {
              const from = current.status;
              current.status = "cancelled";
              current.stopReason = "cleared by user";
              current.updatedAt = nowIso();
              pushHistory(current, "cleared", from, "cancelled");
            }
            return current;
          });
        }
        this.loop.cancel(sessionID);
        this.candidates.clear(sessionID);
        await this.reply(sessionID, updated ? "🧹 Goal cleared." : "No goal to clear.");
        return;
      }
      default:
        await this.reply(sessionID, commandHelp(this.options.commandName));
        return;
    }
  }

  private async startGoalFromCommand(
    sessionID: string,
    objective: string,
    flags: Parameters<typeof mergeLimits>[1],
    invocation: CommandInvocation,
  ): Promise<void> {
    const text = objective.trim();
    if (!text) {
      await this.reply(sessionID, commandHelp(this.options.commandName));
      return;
    }
    const goal = await this.createGoal(sessionID, {
      objective: text,
      criteria: flags.criteria,
      constraints: flags.constraints,
      limits: mergeLimits(this.options.defaultLimits, flags),
      unbounded: flags.unbounded ?? this.options.unboundedByDefault,
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
      limits: ReturnType<typeof mergeLimits>;
      unbounded: boolean;
      verification?: "evidence" | "model" | "agent";
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
        limits: input.limits,
        unbounded: input.unbounded,
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
          limits: goal.unbounded ? { unbounded: true } : goal.limits,
          used: goal.used,
          activeMs: activeMsAt(goal, now),
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
    const limits = { ...this.options.defaultLimits };
    if (input.maxTurns !== undefined) limits.maxTurns = input.maxTurns;
    if (input.maxTokens !== undefined) limits.maxTokens = input.maxTokens;
    if (input.maxDurationMs !== undefined) limits.maxDurationMs = input.maxDurationMs;
    const goal = await this.createGoal(sessionID, {
      objective,
      criteria: input.criteria,
      constraints: input.constraints,
      limits,
      unbounded: input.unbounded ?? this.options.unboundedByDefault,
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

    const decision = await verifyCompletion(
      this.ctx,
      goal.verification ?? this.options.verification,
      this.options.verifierModel,
      this.options.verifierTimeoutMs,
      { goal, candidate, summary, transcript, sessionModel },
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
}
