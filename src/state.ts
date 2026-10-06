/**
 * Pure goal state machine. Every function mutates the passed draft in place
 * and the caller persists it through GoalStore.mutate, which serializes
 * read-modify-write per session.
 */

import type {
  ArchivedGoal,
  Checkpoint,
  EvidenceRecord,
  GoalLimits,
  GoalRecord,
  GoalStatus,
  GoalTask,
  HistoryEntry,
  UsageSnapshot,
} from "./types.js";
import { nowIso } from "./util.js";

const MAX_HISTORY = 100;
const MAX_CHECKPOINTS = 50;
const MAX_ARCHIVE = 20;
const MAX_ARCHIVED_HISTORY = 20;

export interface CreateGoalInput {
  sessionID: string;
  projectID: string;
  locationDirectory: string;
  workspaceID?: string;
  objective: string;
  criteria?: string;
  constraints?: string;
  limits: GoalLimits;
  unbounded: boolean;
  at: string;
  /** Latest observed usage snapshot for the session (goal accounting baseline). */
  baseUsage?: UsageSnapshot;
  /** Per-goal verification override. */
  verification?: "evidence" | "model" | "agent";
}

export function pushHistory(
  goal: GoalRecord,
  action: string,
  from: GoalStatus | string,
  to: GoalStatus | string,
  detail?: string,
): void {
  const entry: HistoryEntry = { at: goal.updatedAt, action, from: String(from), to: String(to) };
  if (detail) entry.detail = detail;
  goal.history.push(entry);
  if (goal.history.length > MAX_HISTORY) goal.history = goal.history.slice(-MAX_HISTORY);
}

function archiveEntry(goal: GoalRecord): ArchivedGoal {
  return {
    goalID: goal.goalID,
    objective: goal.objective,
    criteria: goal.criteria,
    constraints: goal.constraints,
    status: goal.status,
    stopReason: goal.stopReason,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    used: { ...goal.used },
    history: goal.history.slice(-MAX_ARCHIVED_HISTORY),
  };
}

export function cancelGoal(goal: GoalRecord, reason: string, at: string): void {
  if (goal.status === "complete" || goal.status === "cancelled") return;
  stopClock(goal, at);
  const from = goal.status;
  goal.status = "cancelled";
  goal.stopReason = reason;
  goal.updatedAt = at;
  pushHistory(goal, "cancelled", from, "cancelled", reason);
}

function supersededEntry(previous: GoalRecord, at: string): ArchivedGoal {
  if (previous.status === "complete" || previous.status === "cancelled") return archiveEntry(previous);
  const archived = { ...previous, history: [...previous.history] };
  cancelGoal(archived, "superseded by a new goal", at);
  return archiveEntry(archived);
}

export function startGoal(previous: GoalRecord | undefined, input: CreateGoalInput): GoalRecord {
  const archive = previous ? [...(previous.archive ?? []), supersededEntry(previous, input.at)] : [];
  while (archive.length > MAX_ARCHIVE) archive.shift();

  const goal: GoalRecord = {
    v: 1,
    goalID: makeGoalID(input.at),
    sessionID: input.sessionID,
    projectID: input.projectID,
    locationDirectory: input.locationDirectory,
    workspaceID: input.workspaceID,
    objective: input.objective,
    criteria: input.criteria,
    constraints: input.constraints,
    status: "active",
    createdAt: input.at,
    updatedAt: input.at,
    activeSince: input.at,
    activeMs: 0,
    limits: { ...input.limits },
    unbounded: input.unbounded,
    verification: input.verification,
    used: { turns: 0, contextTokens: 0, burnTokens: 0, cost: 0 },
    base: input.baseUsage ? { ...input.baseUsage } : previous?.lastUsage ? { ...previous.lastUsage } : undefined,
    stall: { noToolTurns: 0, noProgressTurns: 0, lastOutputTokens: 0 },
    tasks: [],
    promptFailures: 0,
    evidence: [],
    checkpoints: [],
    history: [],
    archive,
  };
  pushHistory(goal, "created", "-", "active");
  return goal;
}

let goalCounter = 0;
function makeGoalID(at: string): string {
  goalCounter += 1;
  return `goal_${Date.parse(at).toString(36)}_${goalCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function stopClock(goal: GoalRecord, at: string): void {
  if (!goal.activeSince) return;
  const elapsed = Date.parse(at) - Date.parse(goal.activeSince);
  if (Number.isFinite(elapsed) && elapsed > 0) goal.activeMs += elapsed;
  goal.activeSince = undefined;
}

export function activeMsAt(goal: GoalRecord, at: string): number {
  if (!goal.activeSince) return goal.activeMs;
  const elapsed = Date.parse(at) - Date.parse(goal.activeSince);
  return goal.activeMs + (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0);
}

function canWork(status: GoalStatus): boolean {
  return status === "active";
}

export function pauseGoal(goal: GoalRecord, reason: string, at: string): void {
  if (!canWork(goal.status)) return;
  stopClock(goal, at);
  const from = goal.status;
  goal.status = "paused";
  goal.stopReason = reason;
  goal.updatedAt = at;
  pushHistory(goal, "paused", from, "paused", reason);
}

export function resumeGoal(goal: GoalRecord, at: string): void {
  if (goal.status === "active" || goal.status === "complete" || goal.status === "cancelled") return;
  const from = goal.status;
  goal.status = "active";
  delete goal.stopReason;
  delete goal.recovered;
  goal.activeSince = at;
  goal.updatedAt = at;
  pushHistory(goal, "resumed", from, "active");
}

export function blockGoal(goal: GoalRecord, reason: string, at: string): void {
  if (goal.status === "complete" || goal.status === "cancelled") return;
  stopClock(goal, at);
  const from = goal.status;
  goal.status = "blocked";
  goal.stopReason = reason;
  goal.updatedAt = at;
  pushHistory(goal, "blocked", from, "blocked", reason);
}

export function completeGoal(goal: GoalRecord, evidence: EvidenceRecord, at: string): void {
  if (goal.status === "complete" || goal.status === "cancelled") return;
  stopClock(goal, at);
  const from = goal.status;
  goal.status = "complete";
  delete goal.stopReason;
  goal.updatedAt = at;
  goal.evidence.push(evidence);
  pushHistory(goal, "complete", from, "complete", evidence.summary);
}

export function limitGoal(goal: GoalRecord, status: GoalStatus, reason: string, at: string): void {
  if (goal.status !== "active") return;
  stopClock(goal, at);
  goal.status = status;
  goal.stopReason = reason;
  goal.updatedAt = at;
  pushHistory(goal, "limited", "active", status, reason);
}

export function editGoal(goal: GoalRecord, objective: string, at: string): void {
  const from = goal.objective;
  goal.objective = objective;
  goal.updatedAt = at;
  pushHistory(goal, "edited", from, objective);
}

const MAX_TASKS = 50;

function canEditTasks(goal: GoalRecord): boolean {
  return goal.status !== "complete" && goal.status !== "cancelled";
}

export function findTask(goal: GoalRecord, ref: string): GoalTask | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const byID = goal.tasks.find((task) => task.id === trimmed);
  if (byID) return byID;
  const index = Number.parseInt(trimmed, 10);
  if (Number.isInteger(index) && index >= 1 && index <= goal.tasks.length) return goal.tasks[index - 1];
  return undefined;
}

export function addTask(goal: GoalRecord, title: string, at: string): GoalTask | undefined {
  if (!canEditTasks(goal)) return undefined;
  const clean = title.trim();
  if (!clean) return undefined;
  if (goal.tasks.length >= MAX_TASKS) return undefined;
  let counter = goal.tasks.length + 1;
  while (goal.tasks.some((task) => task.id === `t${counter}`)) counter += 1;
  const task: GoalTask = { id: `t${counter}`, title: clean, status: "todo", at, updatedAt: at };
  goal.tasks.push(task);
  goal.updatedAt = at;
  pushHistory(goal, "task", goal.status, goal.status, `added ${task.id}: ${clean}`);
  return task;
}

export function updateTask(
  goal: GoalRecord,
  ref: string,
  status: GoalTask["status"],
  at: string,
): GoalTask | undefined {
  if (!canEditTasks(goal)) return undefined;
  const task = findTask(goal, ref);
  if (!task) return undefined;
  task.status = status;
  task.updatedAt = at;
  goal.updatedAt = at;
  pushHistory(goal, "task", goal.status, goal.status, `${task.id} ${status}: ${task.title}`);
  return task;
}

export function taskSummary(goal: GoalRecord): { total: number; done: number; doing: number } {
  const tasks = goal.tasks ?? [];
  const done = tasks.filter((task) => task.status === "done").length;
  const doing = tasks.filter((task) => task.status === "doing").length;
  return { total: tasks.length, done, doing };
}

function isProgressTool(tool: string): boolean {
  return tool === "edit" || tool === "write" || tool === "patch";
}

export function recordCheckpoint(goal: GoalRecord, checkpoint: Checkpoint): void {
  if (!canWork(goal.status)) return;
  goal.checkpoints.push(checkpoint);
  if (goal.checkpoints.length > MAX_CHECKPOINTS) goal.checkpoints = goal.checkpoints.slice(-MAX_CHECKPOINTS);
  if (checkpoint.progress || isProgressTool(checkpoint.tool)) {
    goal.stall.noToolTurns = 0;
  }
  goal.updatedAt = checkpoint.at;
  pushHistory(goal, "checkpoint", goal.status, goal.status, checkpoint.summary);
}

/** Goal-scoped usage accounting.
 *
 * `snapshot` is the session's cumulative usage (what `session.usage.updated`
 * reports). The optional `call` argument is the per-call delta between this
 * snapshot and the previous one; only that delta represents the actual context
 * window of the latest model call, which is what `maxTokens` compares against.
 * Using the cumulative snapshot here would trip the cap instantly on any long
 * session (found live on a 7.6M-token session).
 */
export function accountUsage(goal: GoalRecord, snapshot: UsageSnapshot, call?: UsageSnapshot): void {
  if (!goal.base) {
    // Baseline unknown (plugin started mid-session): start counting from now.
    goal.base = { ...snapshot };
  }
  goal.lastUsage = { ...snapshot };
  const callTokens = call ? call.input + call.cacheRead + call.output + call.reasoning : 0;
  goal.used.contextTokens = Math.max(0, callTokens);
  goal.used.burnTokens = Math.max(
    0,
    snapshot.input +
      snapshot.output +
      snapshot.reasoning +
      snapshot.cacheRead +
      snapshot.cacheWrite -
      (goal.base.input + goal.base.output + goal.base.reasoning + goal.base.cacheRead + goal.base.cacheWrite),
  );
  goal.used.cost = Math.max(0, snapshot.cost - goal.base.cost);
}

export interface TurnSettlement {
  wasGoalTurn: boolean;
  hadToolCall: boolean;
  outputDelta: number;
  at: string;
  stallOutputTokens: number;
}

export interface LimitVerdict {
  status: GoalStatus;
  reason: string;
}

/** Settle one turn boundary and evaluate limits. Returns a verdict when a cap tripped. */
export function settleTurn(goal: GoalRecord, settlement: TurnSettlement): LimitVerdict | undefined {
  goal.updatedAt = settlement.at;
  if (!canWork(goal.status)) return undefined;

  if (settlement.wasGoalTurn) {
    goal.stall.noToolTurns = settlement.hadToolCall ? 0 : goal.stall.noToolTurns + 1;
    goal.stall.noProgressTurns =
      settlement.outputDelta >= settlement.stallOutputTokens ? 0 : goal.stall.noProgressTurns + 1;
    goal.stall.lastOutputTokens = settlement.outputDelta;
  }

  const limits = goal.limits;
  if (goal.unbounded) {
    if (limits.noToolCallTurns !== undefined && limits.noToolCallTurns > 0 && goal.stall.noToolTurns >= limits.noToolCallTurns) {
      return { status: "stalled", reason: `no tool calls for ${goal.stall.noToolTurns} continuation turns` };
    }
    return undefined;
  }

  if (limits.maxTurns !== undefined && goal.used.turns >= limits.maxTurns) {
    return { status: "budget_limited", reason: `max continuation turns reached (${limits.maxTurns})` };
  }
  if (limits.maxTokens !== undefined && goal.used.contextTokens >= limits.maxTokens) {
    return {
      status: "usage_limited",
      reason: `context token cap reached (${goal.used.contextTokens} >= ${limits.maxTokens})`,
    };
  }
  if (limits.maxDurationMs !== undefined && activeMsAt(goal, settlement.at) >= limits.maxDurationMs) {
    return {
      status: "budget_limited",
      reason: `max duration reached (${Math.round(activeMsAt(goal, settlement.at) / 1000)}s >= ${Math.round(
        limits.maxDurationMs / 1000,
      )}s)`,
    };
  }
  if (limits.noToolCallTurns !== undefined && limits.noToolCallTurns > 0 && goal.stall.noToolTurns >= limits.noToolCallTurns) {
    return { status: "stalled", reason: `no tool calls for ${goal.stall.noToolTurns} continuation turns` };
  }
  if (limits.noProgressTurns !== undefined && limits.noProgressTurns > 0 && goal.stall.noProgressTurns >= limits.noProgressTurns) {
    return { status: "stalled", reason: `low output for ${goal.stall.noProgressTurns} continuation turns` };
  }
  return undefined;
}

export function statusLabel(goal: GoalRecord): string {
  const reason = goal.stopReason ? ` (${goal.stopReason})` : "";
  const recovered = goal.recovered ? ", recovered" : "";
  return `${goal.status}${reason}${recovered}`;
}
