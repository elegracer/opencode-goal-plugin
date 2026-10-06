/**
 * Continuation loop coordinator.
 *
 * Turn boundaries come from `session.execution.*` events (the reliable V2
 * boundary); `session.idle` is only a fallback for builds that do not deliver
 * execution events, and duplicates are filtered by event id and a short time
 * window. The loop never has more than one continuation in flight per session.
 * There are no budget caps: it keeps scheduling until the goal is paused,
 * cleared, completed, or blocked.
 */

import type { GoalRecord } from "./types.js";
import { errorText } from "./util.js";

export interface LoopDeps {
  /** Returns the goal when a continuation is allowed right now, else undefined. */
  canContinue: (sessionID: string) => Promise<GoalRecord | undefined>;
  /** Returns true when a continuation prompt was actually admitted. */
  sendContinuation: (sessionID: string, goal: GoalRecord) => Promise<boolean>;
  onPromptFailure: (sessionID: string, error: unknown) => Promise<void>;
  log: (message: string, data?: unknown) => void;
}

export interface BoundaryResult {
  duplicate: boolean;
  /** True when the boundary closes a goal continuation turn. */
  wasGoalTurn: boolean;
}

interface LoopState {
  busy: boolean;
  compacting: boolean;
  retrying: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** True from the moment a continuation prompt is admitted until its boundary. */
  awaitingBoundary: boolean;
  timer?: ReturnType<typeof setTimeout>;
  lastBoundaryEventID?: string;
  lastBoundaryAt: number;
  /** Once execution events are observed, they are the only trusted boundary. */
  seenExecution: boolean;
}

function freshState(): LoopState {
  return {
    busy: false,
    compacting: false,
    retrying: false,
    awaitingBoundary: false,
    lastBoundaryAt: 0,
    seenExecution: false,
  };
}

export class ContinuationLoop {
  private readonly states = new Map<string, LoopState>();
  private readonly intervalMs: number;
  private disposed = false;

  constructor(
    private readonly deps: LoopDeps,
    intervalMs: number,
  ) {
    this.intervalMs = Math.max(100, intervalMs);
  }

  private state(sessionID: string): LoopState {
    let state = this.states.get(sessionID);
    if (!state) {
      state = freshState();
      this.states.set(sessionID, state);
    }
    return state;
  }

  noteExecutionStarted(sessionID: string): void {
    const state = this.state(sessionID);
    state.busy = true;
    state.seenExecution = true;
    state.retrying = false;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
  }

  isRetrying(sessionID: string): boolean {
    return this.state(sessionID).retrying;
  }

  noteRetryScheduled(sessionID: string): void {
    const state = this.state(sessionID);
    state.retrying = true;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    // A retry that never materializes must not suppress goal handling forever.
    state.retryTimer = setTimeout(() => {
      state.retrying = false;
      state.retryTimer = undefined;
      void this.schedule(sessionID);
    }, 60_000);
  }

  noteCompaction(sessionID: string, active: boolean): void {
    this.state(sessionID).compacting = active;
  }

  /** Clear transient state; the in-flight prompt itself cannot be retracted. */
  cancel(sessionID: string): void {
    const state = this.state(sessionID);
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.awaitingBoundary = false;
  }

  cancelAll(): void {
    for (const sessionID of this.states.keys()) this.cancel(sessionID);
  }

  /**
   * Process a turn boundary. `source` is "execution" for
   * session.execution.succeeded and "idle" for the fallback session.idle.
   */
  noteBoundary(sessionID: string, eventID: string | undefined, source: "execution" | "idle"): BoundaryResult {
    const state = this.state(sessionID);
    const now = Date.now();

    if (source === "execution") {
      state.seenExecution = true;
    } else {
      // `session.idle` is only a fallback for builds that never deliver
      // execution events. Once they are seen, or while a turn is in flight,
      // idle must not settle the turn (a late idle otherwise double-schedules
      // a continuation).
      if (state.seenExecution || state.busy) return { duplicate: true, wasGoalTurn: false };
      if (now - state.lastBoundaryAt < 2_000) return { duplicate: true, wasGoalTurn: false };
    }

    if (eventID && state.lastBoundaryEventID === eventID) {
      return { duplicate: true, wasGoalTurn: false };
    }
    if (eventID) state.lastBoundaryEventID = eventID;
    state.lastBoundaryAt = now;
    state.busy = false;

    const wasGoalTurn = state.awaitingBoundary;
    state.awaitingBoundary = false;
    return { duplicate: false, wasGoalTurn };
  }

  noteFailure(sessionID: string): void {
    const state = this.state(sessionID);
    state.busy = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.awaitingBoundary = false;
  }

  /** Schedule exactly one continuation if allowed. */
  async schedule(sessionID: string): Promise<void> {
    if (this.disposed) return;
    const state = this.state(sessionID);
    if (state.timer || state.awaitingBoundary) return;
    if (state.busy || state.compacting || state.retrying) return;

    const goal = await this.deps.canContinue(sessionID);
    if (!goal) return;
    if (this.disposed || state.timer || state.awaitingBoundary) return;
    if (state.busy || state.compacting || state.retrying) return;

    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.fire(sessionID, goal.goalID);
    }, this.intervalMs);
  }

  private async fire(sessionID: string, goalID: string): Promise<void> {
    if (this.disposed) return;
    const state = this.state(sessionID);
    if (state.busy || state.compacting || state.retrying || state.awaitingBoundary) return;

    const goal = await this.deps.canContinue(sessionID);
    if (!goal || goal.goalID !== goalID) return;
    if (state.busy || state.compacting || state.retrying || state.awaitingBoundary) return;

    state.awaitingBoundary = true;
    try {
      const sent = await this.deps.sendContinuation(sessionID, goal);
      if (!sent) {
        // Another plugin instance already sent this continuation (or the goal
        // changed); release the flag without counting a failure.
        state.awaitingBoundary = false;
        return;
      }
      this.deps.log("continuation sent", { sessionID });
    } catch (error) {
      state.awaitingBoundary = false;
      this.deps.log("continuation prompt failed", { sessionID, error: errorText(error) });
      await this.deps.onPromptFailure(sessionID, error);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      if (state.retryTimer) clearTimeout(state.retryTimer);
    }
    this.states.clear();
  }
}
