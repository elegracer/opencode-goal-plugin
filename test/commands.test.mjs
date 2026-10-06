import test from "node:test";
import assert from "node:assert/strict";
import { formatHistory, formatStatus, formatTasks, parseGoalCommand } from "../dist/commands.js";

test("bare text becomes a set objective", () => {
  const parsed = parseGoalCommand("fix the failing tests");
  assert.equal(parsed.verb, "set");
  assert.equal(parsed.text, "fix the failing tests");
  assert.equal(parsed.error, undefined);
});

test("single-word objectives are accepted", () => {
  assert.equal(parseGoalCommand("refactor").verb, "set");
  assert.equal(parseGoalCommand("refactor").text, "refactor");
});

test("core verbs parse", () => {
  assert.equal(parseGoalCommand("status").verb, "status");
  assert.equal(parseGoalCommand("").verb, "status");
  assert.equal(parseGoalCommand("pause").verb, "pause");
  assert.equal(parseGoalCommand("resume").verb, "resume");
  assert.equal(parseGoalCommand("edit new text").verb, "edit");
  assert.equal(parseGoalCommand("block waiting on key").verb, "block");
  assert.equal(parseGoalCommand("done it passes").verb, "done");
  assert.equal(parseGoalCommand("clear").verb, "clear");
  assert.equal(parseGoalCommand("history").verb, "history");
  assert.equal(parseGoalCommand("task add x").verb, "task");
  assert.equal(parseGoalCommand("help").verb, "help");
});

test("synonym aliases remain verbs so they never become goals", () => {
  assert.equal(parseGoalCommand("complete it passes").verb, "done");
  assert.equal(parseGoalCommand("cancel").verb, "clear");
  assert.equal(parseGoalCommand("stop").verb, "pause");
  assert.equal(parseGoalCommand("continue").verb, "resume");
});

test("typos are rejected with a suggestion instead of creating a goal", () => {
  const paus = parseGoalCommand("paus");
  assert.ok(paus.error);
  assert.match(paus.error, /did you mean "pause"/);

  const sttus = parseGoalCommand("sttus");
  assert.ok(sttus.error);
  assert.match(sttus.error, /did you mean "status"/);

  const cleer = parseGoalCommand("cleer");
  assert.match(cleer.error, /did you mean "clear"/);

  // A real objective whose first word merely resembles a verb is still a set.
  const sentence = parseGoalCommand("restore the backup after the crash");
  assert.equal(sentence.error, undefined);
  assert.equal(sentence.verb, "set");
});

test("removed commands guide instead of creating goals", () => {
  const budget = parseGoalCommand("budget");
  assert.ok(budget.error);
  assert.match(budget.error, /budget limits were removed/);

  const view = parseGoalCommand("view");
  assert.match(view.error, /use \/goal status/);

  const log = parseGoalCommand("log");
  assert.match(log.error, /use \/goal history/);
});

test("flags parse for criteria, constraints and verify", () => {
  const parsed = parseGoalCommand('ship it --criteria "tests pass" --constraints "no API change" --verify model');
  assert.equal(parsed.verb, "set");
  assert.equal(parsed.text, "ship it");
  assert.equal(parsed.flags.criteria, "tests pass");
  assert.equal(parsed.flags.constraints, "no API change");
  assert.equal(parsed.flags.verification, "model");
});

test("unknown budget flags and bad verify values are rejected", () => {
  assert.match(parseGoalCommand("fix --tokens 100k").error, /unknown flag/);
  assert.match(parseGoalCommand("fix --unbounded").error, /unknown flag/);
  assert.match(parseGoalCommand("fix --verify agent").error, /evidence or model/);
});

test("formatStatus reports no-goal and goal summaries without caps", () => {
  assert.match(formatStatus(undefined, []), /No goal/);
  const goal = {
    goalID: "goal_1",
    objective: "fix tests",
    status: "active",
    criteria: "tests pass",
    constraints: undefined,
    stopReason: undefined,
    recovered: false,
    used: { turns: 2, contextTokens: 400, burnTokens: 0, cost: 0 },
    activeSince: new Date().toISOString(),
    activeMs: 0,
    checkpoints: [{ at: new Date().toISOString(), tool: "shell", callID: "c1", summary: "42 tests", progress: false }],
    evidence: [],
    history: [],
    archive: [],
    tasks: [],
  };
  const text = formatStatus(goal, [{ callID: "call_9", tool: "shell", summary: "s", at: "t", progress: false }]);
  assert.match(text, /fix tests/);
  assert.match(text, /Status: active/);
  assert.match(text, /turns 2/);
  assert.match(text, /call_9/);
  assert.doesNotMatch(text, /maxTokens|Budget/);
  assert.match(formatHistory(goal), /History/);
});

test("formatTasks lists tasks and progress", () => {
  assert.match(formatTasks(undefined), /No goal/);
  const goal = {
    tasks: [
      { id: "t1", title: "write tests", status: "doing", at: "t", updatedAt: "t" },
      { id: "t2", title: "ship it", status: "done", at: "t", updatedAt: "t" },
    ],
  };
  const text = formatTasks(goal);
  assert.match(text, /1\/2 done/);
  assert.match(text, /t1/);
  assert.match(text, /ship it/);
});
