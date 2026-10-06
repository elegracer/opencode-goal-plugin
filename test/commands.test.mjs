import test from "node:test";
import assert from "node:assert/strict";
import { formatHistory, formatStatus, mergeLimits, parseGoalCommand } from "../dist/commands.js";

test("bare text becomes a set objective", () => {
  const parsed = parseGoalCommand("fix the failing tests");
  assert.equal(parsed.verb, "set");
  assert.equal(parsed.text, "fix the failing tests");
  assert.equal(parsed.error, undefined);
});

test("verbs and aliases parse", () => {
  assert.equal(parseGoalCommand("status").verb, "status");
  assert.equal(parseGoalCommand("").verb, "status");
  assert.equal(parseGoalCommand("stop").verb, "pause");
  assert.equal(parseGoalCommand("cancel").verb, "clear");
  assert.equal(parseGoalCommand("create ship it").verb, "set");
  assert.equal(parseGoalCommand("create ship it").text, "ship it");
  assert.equal(parseGoalCommand("complete it passes").verb, "done");
  assert.equal(parseGoalCommand("history").verb, "history");
});

test("flags parse with values, equals, and amounts", () => {
  const parsed = parseGoalCommand('ship it --turns 20 --tokens=150k --minutes 30 --criteria "tests pass" --constraints "no API change"');
  assert.equal(parsed.verb, "set");
  assert.equal(parsed.text, "ship it");
  assert.equal(parsed.flags.maxTurns, 20);
  assert.equal(parsed.flags.maxTokens, 150_000);
  assert.equal(parsed.flags.maxDurationMs, 30 * 60_000);
  assert.equal(parsed.flags.criteria, "tests pass");
  assert.equal(parsed.flags.constraints, "no API change");
});

test("unknown flags and bad values are rejected", () => {
  assert.match(parseGoalCommand("fix --nope 1").error, /unknown flag/);
  assert.match(parseGoalCommand("fix --tokens zero").error, /positive number/);
  assert.match(parseGoalCommand("fix --verify whatever").error, /evidence, model, or agent/);
});

test("mergeLimits applies flag overrides", () => {
  const limits = mergeLimits({ maxTurns: 10, maxTokens: 1000, maxDurationMs: 5000 }, { maxTurns: 3 });
  assert.deepEqual(limits, { maxTurns: 3, maxTokens: 1000, maxDurationMs: 5000 });
});

test("formatStatus reports no-goal and goal summaries", () => {
  assert.match(formatStatus(undefined, []), /No goal/);
  const goal = {
    goalID: "goal_1",
    objective: "fix tests",
    status: "active",
    criteria: "tests pass",
    constraints: undefined,
    stopReason: undefined,
    recovered: false,
    limits: { maxTurns: 10, maxTokens: 1000, maxDurationMs: 60_000 },
    unbounded: false,
    used: { turns: 2, contextTokens: 400, burnTokens: 0, cost: 0 },
    activeSince: new Date().toISOString(),
    activeMs: 0,
    checkpoints: [{ at: new Date().toISOString(), tool: "shell", callID: "c1", summary: "42 tests", progress: false }],
    evidence: [],
    history: [],
    archive: [],
  };
  const text = formatStatus(goal, [{ callID: "call_9", tool: "shell", summary: "s", at: "t", progress: false }]);
  assert.match(text, /fix tests/);
  assert.match(text, /Status: active/);
  assert.match(text, /call_9/);
  assert.match(formatHistory(goal), /History/);
});
