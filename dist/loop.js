/**
 * Continuation loop coordinator.
 *
 * Turn boundaries come from `session.execution.*` events (the reliable V2
 * boundary); `session.idle` is only a fallback for builds that do not deliver
 * execution events, and duplicates are filtered by event id and a short
 * time window. The loop never has more than one continuation in flight per
 * session.
 */
import { errorText } from "./util.js";
function freshState() {
    return {
        busy: false,
        compacting: false,
        retrying: false,
        awaitingBoundary: false,
        lastBoundaryAt: 0,
        turnHadToolCall: false,
        promptFailures: 0,
        wrapUpSent: false,
        seenExecution: false,
    };
}
export class ContinuationLoop {
    deps;
    states = new Map();
    intervalMs;
    disposed = false;
    constructor(deps, intervalMs) {
        this.deps = deps;
        this.intervalMs = Math.max(100, intervalMs);
    }
    state(sessionID) {
        let state = this.states.get(sessionID);
        if (!state) {
            state = freshState();
            this.states.set(sessionID, state);
        }
        return state;
    }
    noteExecutionStarted(sessionID) {
        const state = this.state(sessionID);
        state.busy = true;
        state.turnHadToolCall = false;
        state.seenExecution = true;
        state.retrying = false;
        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
            state.retryTimer = undefined;
        }
    }
    noteToolCall(sessionID) {
        this.state(sessionID).turnHadToolCall = true;
    }
    isRetrying(sessionID) {
        return this.state(sessionID).retrying;
    }
    noteRetryScheduled(sessionID) {
        const state = this.state(sessionID);
        state.retrying = true;
        if (state.retryTimer)
            clearTimeout(state.retryTimer);
        // A retry that never materializes must not suppress goal handling forever.
        state.retryTimer = setTimeout(() => {
            state.retrying = false;
            state.retryTimer = undefined;
            void this.schedule(sessionID);
        }, 60_000);
    }
    noteCompaction(sessionID, active) {
        this.state(sessionID).compacting = active;
    }
    /** Clear transient state; the in-flight prompt itself cannot be retracted. */
    cancel(sessionID) {
        const state = this.state(sessionID);
        if (state.timer)
            clearTimeout(state.timer);
        state.timer = undefined;
        state.awaitingBoundary = false;
    }
    cancelAll() {
        for (const sessionID of this.states.keys())
            this.cancel(sessionID);
    }
    /**
     * Process a turn boundary. `source` is "execution" for
     * session.execution.succeeded and "idle" for the fallback session.idle.
     */
    noteBoundary(sessionID, eventID, source) {
        const state = this.state(sessionID);
        const now = Date.now();
        if (source === "execution") {
            state.seenExecution = true;
        }
        else {
            // `session.idle` is only a fallback for builds that never deliver
            // execution events. Once they are seen, or while a turn is in flight,
            // idle must not settle the turn (a late idle otherwise double-schedules
            // a continuation).
            if (state.seenExecution || state.busy) {
                return { duplicate: true, wasGoalTurn: false, hadToolCall: false };
            }
            // A reliable execution boundary for the same turn suppresses idle.
            if (now - state.lastBoundaryAt < 2_000)
                return { duplicate: true, wasGoalTurn: false, hadToolCall: false };
        }
        if (eventID && state.lastBoundaryEventID === eventID) {
            return { duplicate: true, wasGoalTurn: false, hadToolCall: false };
        }
        if (eventID)
            state.lastBoundaryEventID = eventID;
        state.lastBoundaryAt = now;
        state.busy = false;
        const wasGoalTurn = state.awaitingBoundary;
        state.awaitingBoundary = false;
        const hadToolCall = state.turnHadToolCall;
        state.turnHadToolCall = false;
        return { duplicate: false, wasGoalTurn, hadToolCall };
    }
    noteFailure(sessionID) {
        const state = this.state(sessionID);
        state.busy = false;
        if (state.timer)
            clearTimeout(state.timer);
        state.timer = undefined;
        state.awaitingBoundary = false;
    }
    /** Returns the number of consecutive prompt failures after this one. */
    notePromptFailure(sessionID) {
        const state = this.state(sessionID);
        state.promptFailures += 1;
        return state.promptFailures;
    }
    resetPromptFailures(sessionID) {
        this.state(sessionID).promptFailures = 0;
    }
    wrapUpAlreadySent(sessionID) {
        return this.state(sessionID).wrapUpSent;
    }
    markWrapUpSent(sessionID) {
        this.state(sessionID).wrapUpSent = true;
    }
    /** Schedule exactly one continuation if allowed. */
    async schedule(sessionID) {
        if (this.disposed)
            return;
        const state = this.state(sessionID);
        if (state.timer || state.awaitingBoundary)
            return;
        if (state.busy || state.compacting || state.retrying)
            return;
        const goal = await this.deps.canContinue(sessionID);
        if (!goal)
            return;
        if (this.disposed || state.timer || state.awaitingBoundary)
            return;
        if (state.busy || state.compacting || state.retrying)
            return;
        state.timer = setTimeout(() => {
            state.timer = undefined;
            void this.fire(sessionID, goal.goalID);
        }, this.intervalMs);
    }
    async fire(sessionID, goalID) {
        if (this.disposed)
            return;
        const state = this.state(sessionID);
        if (state.busy || state.compacting || state.retrying || state.awaitingBoundary)
            return;
        const goal = await this.deps.canContinue(sessionID);
        if (!goal || goal.goalID !== goalID)
            return;
        if (state.busy || state.compacting || state.retrying || state.awaitingBoundary)
            return;
        state.awaitingBoundary = true;
        try {
            const sent = await this.deps.sendContinuation(sessionID, goal);
            if (!sent) {
                // Another plugin instance already sent this continuation (or the goal
                // changed); release the flag without counting a turn or a failure.
                state.awaitingBoundary = false;
                return;
            }
            state.promptFailures = 0;
            this.deps.log("continuation sent", { sessionID });
        }
        catch (error) {
            state.awaitingBoundary = false;
            this.deps.log("continuation prompt failed", { sessionID, error: errorText(error) });
            await this.deps.onPromptFailure(sessionID, error);
        }
    }
    dispose() {
        this.disposed = true;
        for (const state of this.states.values()) {
            if (state.timer)
                clearTimeout(state.timer);
            if (state.retryTimer)
                clearTimeout(state.retryTimer);
        }
        this.states.clear();
    }
}
