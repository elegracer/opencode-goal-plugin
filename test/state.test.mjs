import test from "node:test";
import assert from "node:assert/strict";
import {
  accountUsage,
  activeMsAt,
  completeGoal,
  limitGoal,
  pauseGoal,
  recordCheckpoint,
  resumeGoal,
  settleTurn,
  startGoal,
} from "../dist/state.js";

const baseInput = {
  sessionID: "ses_1",
  projectID: "proj_1",
  locationDirectory: "/work",
  objective: "fix tests",
  limits: { maxTurns: 3, maxTokens: 1000, maxDurationMs: 60_000, noToolCallTurns: 2, noProgressTurns: 2 },
  unbounded: false,
  at: "2026-01-01T00:00:00.000Z",
};

test("startGoal creates an active goal", () => {
  const goal = startGoal(undefined, baseInput);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, "fix tests");
  assert.equal(goal.used.turns, 0);
  assert.equal(goal.history.length, 1);
  assert.equal(goal.archive.length, 0);
});

test("startGoal archives the previous goal and keeps the usage baseline", () => {
  const first = startGoal(undefined, baseInput);
  first.lastUsage = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
  const second = startGoal(first, { ...baseInput, at: "2026-01-01T00:10:00.000Z" });
  assert.equal(second.archive.length, 1);
  assert.equal(second.archive[0].objective, "fix tests");
  assert.deepEqual(second.base, first.lastUsage);
});

test("pause and resume manage the active clock", () => {
  const goal = startGoal(undefined, baseInput);
  pauseGoal(goal, "user", "2026-01-01T00:00:10.000Z");
  assert.equal(goal.status, "paused");
  assert.equal(goal.stopReason, "user");
  assert.equal(goal.activeMs, 10_000);
  assert.equal(activeMsAt(goal, "2026-01-01T00:01:00.000Z"), 10_000);
  resumeGoal(goal, "2026-01-01T00:01:00.000Z");
  assert.equal(goal.status, "active");
  assert.equal(goal.recovered, undefined);
  assert.equal(activeMsAt(goal, "2026-01-01T00:01:05.000Z"), 15_000);
});

test("usage accounting is goal-scoped and cumulative", () => {
  const goal = startGoal(undefined, baseInput);
  accountUsage(goal, { input: 100, output: 20, reasoning: 5, cacheRead: 30, cacheWrite: 1, cost: 0.5 });
  assert.deepEqual(goal.base, { input: 100, output: 20, reasoning: 5, cacheRead: 30, cacheWrite: 1, cost: 0.5 });
  assert.equal(goal.used.burnTokens, 0);
  assert.equal(goal.used.contextTokens, 125);
  accountUsage(goal, { input: 300, output: 60, reasoning: 10, cacheRead: 80, cacheWrite: 2, cost: 1.5 });
  assert.equal(goal.used.burnTokens, 300 - 100 + (60 - 20) + (10 - 5) + (80 - 30) + (2 - 1));
  assert.equal(goal.used.contextTokens, 370);
  assert.equal(Math.round(goal.used.cost * 100), 100);
});

test("turn settlement trips the turn cap", () => {
  const goal = startGoal(undefined, baseInput);
  goal.used.turns = 3;
  const verdict = settleTurn(goal, {
    wasGoalTurn: true,
    hadToolCall: true,
    outputDelta: 200,
    at: "2026-01-01T00:00:01.000Z",
    stallOutputTokens: 50,
  });
  assert.ok(verdict);
  assert.equal(verdict.status, "budget_limited");
  limitGoal(goal, verdict.status, verdict.reason, "2026-01-01T00:00:01.000Z");
  assert.equal(goal.status, "budget_limited");
});

test("turn settlement trips the context token cap", () => {
  const goal = startGoal(undefined, baseInput);
  goal.used.contextTokens = 1001;
  const verdict = settleTurn(goal, {
    wasGoalTurn: true,
    hadToolCall: true,
    outputDelta: 200,
    at: "2026-01-01T00:00:01.000Z",
    stallOutputTokens: 50,
  });
  assert.equal(verdict?.status, "usage_limited");
});

test("tool-free continuation turns stall", () => {
  const goal = startGoal(undefined, baseInput);
  const settle = (at) =>
    settleTurn(goal, { wasGoalTurn: true, hadToolCall: false, outputDelta: 100, at, stallOutputTokens: 50 });
  assert.equal(settle("2026-01-01T00:00:01.000Z"), undefined);
  const verdict = settle("2026-01-01T00:00:02.000Z");
  assert.equal(verdict?.status, "stalled");
});

test("low-output continuation turns stall", () => {
  const goal = startGoal(undefined, baseInput);
  const settle = (at) =>
    settleTurn(goal, { wasGoalTurn: true, hadToolCall: true, outputDelta: 5, at, stallOutputTokens: 50 });
  assert.equal(settle("2026-01-01T00:00:01.000Z"), undefined);
  const verdict = settle("2026-01-01T00:00:02.000Z");
  assert.equal(verdict?.status, "stalled");
});

test("unbounded goals still stall on repeated tool-free turns", () => {
  const goal = startGoal(undefined, { ...baseInput, unbounded: true, limits: { noToolCallTurns: 1 } });
  goal.used.turns = 100;
  goal.used.contextTokens = 999_999;
  const verdict = settleTurn(goal, {
    wasGoalTurn: true,
    hadToolCall: false,
    outputDelta: 100,
    at: "2026-01-01T00:00:01.000Z",
    stallOutputTokens: 50,
  });
  assert.equal(verdict?.status, "stalled");
});

test("checkpoints reset the tool-free counter and cap the ring", () => {
  const goal = startGoal(undefined, baseInput);
  goal.stall.noToolTurns = 2;
  for (let i = 0; i < 60; i++) {
    recordCheckpoint(goal, {
      at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      tool: "edit",
      callID: `call_${i}`,
      summary: `edited file ${i}`,
      progress: true,
    });
  }
  assert.equal(goal.stall.noToolTurns, 0);
  assert.equal(goal.checkpoints.length, 50);
});

test("completeGoal records evidence and stops the clock", () => {
  const goal = startGoal(undefined, baseInput);
  completeGoal(
    goal,
    { at: "2026-01-01T00:00:05.000Z", candidateID: "call_1", tool: "shell", summary: "npm test passed", tier: "evidence", reason: "ok" },
    "2026-01-01T00:00:05.000Z",
  );
  assert.equal(goal.status, "complete");
  assert.equal(goal.evidence.length, 1);
  assert.equal(goal.activeMs, 5_000);
});
