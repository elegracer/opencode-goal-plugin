/**
 * Plugin domain types. All records here are plain JSON-serializable objects
 * because they are persisted through the host plugin storage.
 */

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "complete"
  | "cancelled"
  | "budget_limited"
  | "usage_limited"
  | "stalled";

export const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set(["complete", "cancelled"]);

export interface GoalLimits {
  maxTurns?: number;
  /** Maximum context window tokens of a single model call (input + cached input + output + reasoning). */
  maxTokens?: number;
  maxDurationMs?: number;
  /** Consecutive goal continuation turns with no tool call before stalling. */
  noToolCallTurns?: number;
  /** Consecutive goal continuation turns below the output threshold before stalling. */
  noProgressTurns?: number;
}

export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface Checkpoint {
  at: string;
  tool: string;
  callID: string;
  summary: string;
  progress: boolean;
}

export interface HistoryEntry {
  at: string;
  action: string;
  from: string;
  to: string;
  detail?: string;
}

export interface EvidenceRecord {
  at: string;
  candidateID: string;
  tool: string;
  summary: string;
  tier: string;
  reason: string;
}

export interface ArchivedGoal {
  goalID: string;
  objective: string;
  criteria?: string;
  constraints?: string;
  status: GoalStatus;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  used: GoalUsed;
  history: HistoryEntry[];
}

export interface GoalUsed {
  turns: number;
  /** Context tokens of the latest model call (input + output + reasoning). */
  contextTokens: number;
  /** Cumulative tokens processed since the goal started. */
  burnTokens: number;
  /** Cumulative cost in USD since the goal started. */
  cost: number;
}

export interface GoalStall {
  noToolTurns: number;
  noProgressTurns: number;
  lastOutputTokens: number;
}

export interface GoalTask {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  at: string;
  updatedAt: string;
}

export interface GoalRecord {
  v: 1;
  goalID: string;
  sessionID: string;
  projectID: string;
  locationDirectory: string;
  workspaceID?: string;
  objective: string;
  criteria?: string;
  constraints?: string;
  status: GoalStatus;
  stopReason?: string;
  recovered?: boolean;
  createdAt: string;
  updatedAt: string;
  activeSince?: string;
  activeMs: number;
  limits: GoalLimits;
  unbounded: boolean;
  /** Per-goal verification override; falls back to the plugin option. */
  verification?: "evidence" | "model" | "agent";
  used: GoalUsed;
  /** Usage snapshot at goal start (goal-scoped accounting baseline). */
  base?: UsageSnapshot;
  /** Latest observed usage snapshot (persisted so restarts keep accounting). */
  lastUsage?: UsageSnapshot;
  stall: GoalStall;
  tasks: GoalTask[];
  evidence: EvidenceRecord[];
  checkpoints: Checkpoint[];
  history: HistoryEntry[];
  archive: ArchivedGoal[];
}

export interface EvidenceCandidate {
  callID: string;
  tool: string;
  summary: string;
  at: string;
  messageID?: string;
  progress: boolean;
}
