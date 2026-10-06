import test from "node:test";
import assert from "node:assert/strict";
import {
  accountUsage,
  activeMsAt,
  addTask,
  cancelGoal,
  completeGoal,
  findTask,
  pauseGoal,
  recordCheckpoint,
  resumeGoal,
  startGoal,
  taskSummary,
  updateTask,
} from "../dist/state.js";

const baseInput = {
  sessionID: "ses_1",
  projectID: "proj_1",
  locationDirectory: "/work",
  objective: "fix tests",
  at: "2026-01-01T00:00:00.000Z",
};

test("startGoal creates an active goal without caps", () => {
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
  assert.equal(second.archive[0].status, "cancelled");
  assert.match(second.archive[0].stopReason, /superseded/);
  assert.deepEqual(second.base, first.lastUsage);
});

test("startGoal preserves terminal archived statuses", () => {
  const first = startGoal(undefined, baseInput);
  completeGoal(
    first,
    { at: "2026-01-01T00:00:05.000Z", candidateID: "c", tool: "shell", summary: "s", tier: "evidence", reason: "ok" },
    "2026-01-01T00:00:05.000Z",
  );
  const second = startGoal(first, { ...baseInput, at: "2026-01-01T00:10:00.000Z" });
  assert.equal(second.archive[0].status, "complete");
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

test("cancelGoal stops the clock and records one history entry", () => {
  const goal = startGoal(undefined, baseInput);
  cancelGoal(goal, "cleared by user", "2026-01-01T00:00:07.000Z");
  assert.equal(goal.status, "cancelled");
  assert.equal(goal.activeMs, 7_000);
  assert.equal(goal.activeSince, undefined);
  const last = goal.history[goal.history.length - 1];
  assert.equal(last.action, "cancelled");
  assert.equal(last.detail, "cleared by user");
  cancelGoal(goal, "again", "2026-01-01T00:00:09.000Z");
  assert.equal(goal.history.length, 2);
});

test("usage accounting is goal-scoped and per-call for context", () => {
  const goal = startGoal(undefined, baseInput);
  const first = { input: 100, output: 20, reasoning: 5, cacheRead: 30, cacheWrite: 1, cost: 0.5 };
  accountUsage(goal, first);
  assert.deepEqual(goal.base, first);
  assert.equal(goal.used.burnTokens, 0);
  assert.equal(goal.used.contextTokens, 0); // no per-call delta on the baseline event

  const second = { input: 300, output: 60, reasoning: 10, cacheRead: 80, cacheWrite: 2, cost: 1.5 };
  const call = { input: 200, output: 40, reasoning: 5, cacheRead: 50, cacheWrite: 1, cost: 1.0 };
  accountUsage(goal, second, call);
  assert.equal(goal.used.contextTokens, 200 + 50 + 40 + 5);
  assert.equal(goal.used.burnTokens, 200 + 40 + 5 + 50 + 1);
  assert.equal(Math.round(goal.used.cost * 100), 100);
});

test("cumulative session totals are display-only and never stop a goal", () => {
  const goal = startGoal(undefined, baseInput);
  accountUsage(goal, { input: 7_000_000, output: 100_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 5 });
  assert.equal(goal.status, "active");
  assert.equal(goal.used.burnTokens, 0);
});

test("checkpoints keep a bounded ring", () => {
  const goal = startGoal(undefined, baseInput);
  for (let i = 0; i < 60; i++) {
    recordCheckpoint(goal, {
      at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      tool: "edit",
      callID: `call_${i}`,
      summary: `edited file ${i}`,
      progress: true,
    });
  }
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

test("task list helpers add, resolve by id or number, and update", () => {
  const goal = startGoal(undefined, baseInput);
  const t1 = addTask(goal, "write tests", "2026-01-01T00:00:01.000Z");
  const t2 = addTask(goal, "ship it", "2026-01-01T00:00:02.000Z");
  assert.equal(t1.id, "t1");
  assert.equal(t2.id, "t2");
  assert.equal(findTask(goal, "t1").title, "write tests");
  assert.equal(findTask(goal, "2").title, "ship it");
  assert.equal(findTask(goal, "t9"), undefined);
  assert.equal(findTask(goal, ""), undefined);

  updateTask(goal, "1", "doing", "2026-01-01T00:00:03.000Z");
  updateTask(goal, "t2", "done", "2026-01-01T00:00:04.000Z");
  assert.equal(findTask(goal, "t1").status, "doing");
  assert.equal(findTask(goal, "t2").status, "done");
  assert.deepEqual(taskSummary(goal), { total: 2, done: 1, doing: 1 });
});

test("task edits are rejected for closed goals and empty titles", () => {
  const goal = startGoal(undefined, baseInput);
  assert.equal(addTask(goal, "   ", "2026-01-01T00:00:01.000Z"), undefined);
  completeGoal(
    goal,
    { at: "2026-01-01T00:00:05.000Z", candidateID: "c", tool: "shell", summary: "s", tier: "evidence", reason: "ok" },
    "2026-01-01T00:00:05.000Z",
  );
  assert.equal(addTask(goal, "late", "2026-01-01T00:00:06.000Z"), undefined);
  assert.equal(updateTask(goal, "t1", "done", "2026-01-01T00:00:06.000Z"), undefined);
});
