import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { GoalController } from "../dist/controller.js";
import { GoalStore } from "../dist/store.js";
import { startGoal } from "../dist/state.js";

const scope = { projectID: "proj_1", directory: "/work/project" };

async function setup(input = {}) {
  const harness = createHarness({
    options: { continuationIntervalMs: 110, verification: "evidence", ...(input.options ?? {}) },
    ...input,
  });
  const controller = new GoalController(harness.ctx);
  await controller.start();
  return { harness, controller };
}

const storeFor = (harness) => new GoalStore(harness.ctx.storage, scope);

test("status reports no goal on a fresh session", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("status");
  assert.match(harness.synthetics.at(-1).text, /No goal/);
  controller.dispose();
});

test("setting a goal stores it, replies, and starts work", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand('fix tests --turns 5 --criteria "tests pass" --constraints "no api change"');
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, "fix tests");
  assert.equal(goal.limits.maxTurns, 5);
  assert.equal(goal.criteria, "tests pass");
  assert.equal(goal.constraints, "no api change");
  assert.match(harness.synthetics.at(-1).text, /Goal started/);
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.prompts[0].text, "fix tests");
  assert.equal(harness.prompts[0].metadata["opencode.goal.internal"], true);
  controller.dispose();
});

test("turn boundaries auto-continue once and account the turn", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  harness.emitEvent("session.execution.started", { sessionID: "ses_main" });
  harness.emitEvent("session.execution.succeeded", { sessionID: "ses_main" });
  await harness.wait(300);
  const continuations = harness.prompts.filter((prompt) => /Continue working/.test(prompt.text ?? ""));
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0].metadata["opencode.goal.internal"], true);
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.used.turns, 1);
  controller.dispose();
});

test("duplicate boundary events do not double-continue", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  harness.emitEvent("session.execution.started", { sessionID: "ses_main" });
  const event = harness.emitEvent("session.execution.succeeded", { sessionID: "ses_main" });
  harness.emitEvent("session.execution.succeeded", { sessionID: "ses_main" }, { id: event.id });
  harness.emitEvent("session.idle", { sessionID: "ses_main" });
  await harness.wait(300);
  const continuations = harness.prompts.filter((prompt) => /Continue working/.test(prompt.text ?? ""));
  assert.equal(continuations.length, 1);
  controller.dispose();
});

test("evidence candidates gate completion", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  harness.emitEvent("session.execution.started", { sessionID: "ses_main" });
  harness.emitEvent("session.execution.succeeded", { sessionID: "ses_main" });
  await harness.wait(250);

  // A failed tool call records no evidence.
  await harness.fireToolAfter({
    tool: "shell",
    id: "call_fail",
    status: "error",
    sessionID: "ses_main",
    result: { content: "boom" },
    error: { message: "exit 1" },
  });
  const rejected = await harness.runTool("goal_update", {
    action: "complete",
    evidence: { candidateID: "call_fail", summary: "npm test passed 42/42 in /work/log.txt" },
  });
  assert.match(rejected.content, /not valid/);
  let goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");

  // A successful tool call becomes a valid candidate.
  await harness.fireToolAfter({
    tool: "shell",
    id: "call_ok",
    status: "completed",
    sessionID: "ses_main",
    result: { content: "42 passing" },
  });
  goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.checkpoints.length, 1);

  const get = await harness.runTool("goal_get", {});
  assert.match(get.content, /call_ok/);

  const completed = await harness.runTool("goal_update", {
    action: "complete",
    evidence: { candidateID: "call_ok", summary: "npm test passed 42/42, output in /work/log.txt" },
  });
  assert.match(completed.content, /completed/);
  goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "complete");
  assert.equal(goal.evidence.length, 1);
  assert.equal(goal.evidence[0].tier, "evidence");
  controller.dispose();
});

test("model verification rejection pauses the goal", async () => {
  const { harness, controller } = await setup({
    options: { verification: "model", verifierModel: "test/verifier" },
  });
  harness.setGenerateResponse({ text: "REJECT\nThe evidence does not cover the second requirement." });
  await harness.runCommand("fix tests --verify model");
  await harness.fireToolAfter({
    tool: "shell",
    id: "call_ok",
    status: "completed",
    sessionID: "ses_main",
    result: { content: "42 passing" },
  });
  const result = await harness.runTool("goal_update", {
    action: "complete",
    evidence: { candidateID: "call_ok", summary: "npm test passed 42/42, output in /work/log.txt" },
  });
  assert.match(result.content, /rejected/i);
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "paused");
  assert.match(goal.stopReason, /completion rejected \(model\)/);
  assert.equal(harness.generated.length, 1);
  controller.dispose();
});

test("user messages pause auto-continuation by default", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  await harness.firePrompt({ sessionID: "ses_main", prompt: { text: "actually stop" }, metadata: {} });
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "paused");
  assert.equal(goal.stopReason, "user message");
  controller.dispose();
});

test("internal continuation prompts never pause the goal", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  await harness.firePrompt({
    sessionID: "ses_main",
    prompt: { text: "continue" },
    metadata: { "opencode.goal.internal": true },
  });
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");
  controller.dispose();
});

test("pause and resume round-trip through the command", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  await harness.runCommand("pause");
  let goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "paused");
  await harness.runCommand("resume");
  goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");
  assert.equal(goal.recovered, undefined);
  controller.dispose();
});

test("clear archives the state and blocks new completion", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  await harness.runCommand("clear");
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "cancelled");
  assert.match(harness.synthetics.at(-1).text, /cleared/);
  await harness.runCommand("clear");
  assert.match(harness.synthetics.at(-1).text, /already cancelled/);
  controller.dispose();
});

test("a new goal supersedes and archives the previous one as cancelled", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  await harness.runCommand("ship the release");
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.objective, "ship the release");
  assert.equal(goal.archive.length, 1);
  assert.equal(goal.archive[0].status, "cancelled");
  assert.match(goal.archive[0].stopReason, /superseded/);
  controller.dispose();
});

test("restart recovery downgrades active goals to paused", async () => {
  const harness = createHarness({ options: { continuationIntervalMs: 110 } });
  const store = storeFor(harness);
  await store.mutate("ses_main", () =>
    startGoal(undefined, {
      sessionID: "ses_main",
      projectID: "proj_1",
      locationDirectory: "/work/project",
      objective: "survives restart",
      limits: { maxTurns: 3 },
      unbounded: false,
      at: new Date().toISOString(),
    }),
  );
  const controller = new GoalController(harness.ctx);
  await controller.start();
  const goal = await store.load("ses_main");
  assert.equal(goal.status, "paused");
  assert.equal(goal.recovered, true);
  assert.match(goal.stopReason, /recovered after restart/);
  controller.dispose();
});

test("retry grace prevents a transient failure from pausing", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  harness.emitEvent("session.execution.failed", { sessionID: "ses_main", error: { message: "connection reset" } });
  harness.emitEvent("session.retry.scheduled", { sessionID: "ses_main", attempt: 2 });
  await harness.wait(2_800);
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");
  controller.dispose();
});

test("long-session cumulative usage does not trip the token cap", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests --tokens 100k");
  // Baseline snapshot: cumulative session totals already far above the cap.
  harness.emitEvent("session.usage.updated", {
    sessionID: "ses_main",
    tokens: { input: 7_000_000, output: 100_000, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 5,
  });
  await harness.wait(60);
  let goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.used.contextTokens, 0);

  // Next call: 50k input + 2k cached input + 300 output = 52.3k context.
  harness.emitEvent("session.usage.updated", {
    sessionID: "ses_main",
    tokens: { input: 7_050_000, output: 100_300, reasoning: 0, cache: { read: 2_000, write: 0 } },
    cost: 5.1,
  });
  await harness.wait(60);
  goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.used.contextTokens, 52_300);

  harness.emitEvent("session.execution.started", { sessionID: "ses_main" });
  harness.emitEvent("session.execution.succeeded", { sessionID: "ses_main" });
  await harness.wait(250);
  goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");
  assert.equal(goal.used.turns, 1);
  controller.dispose();
});

test("user interrupt pauses the goal", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  harness.emitEvent("session.execution.started", { sessionID: "ses_main" });
  harness.emitEvent("session.execution.interrupted", { sessionID: "ses_main", reason: "user" });
  await harness.wait(100);
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "paused");
  assert.equal(goal.stopReason, "interrupted by user");
  controller.dispose();
});

test("child sessions neither pause nor drive the parent goal", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  harness.sessionInfos.set("ses_child", {
    id: "ses_child",
    parentID: "ses_main",
    projectID: "proj_1",
    location: { directory: "/work/project" },
  });
  const asyncPrompt = await harness.firePrompt({
    sessionID: "ses_child",
    prompt: { text: "delegate" },
    metadata: {},
  });
  assert.equal(asyncPrompt, undefined);
  let goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");

  harness.emitEvent("session.execution.succeeded", { sessionID: "ses_child" });
  await harness.wait(250);
  const continuations = harness.prompts.filter((prompt) => /Continue working/.test(prompt.text ?? ""));
  assert.equal(continuations.length, 0);
  controller.dispose();
});

test("context injection carries the objective into child sessions", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests --criteria \"tests pass\"");
  harness.sessionInfos.set("ses_child", {
    id: "ses_child",
    parentID: "ses_main",
    projectID: "proj_1",
    location: { directory: "/work/project" },
  });
  const system = await harness.fireContext("ses_child");
  assert.equal(system.length, 1);
  assert.match(system[0].text, /fix tests/);
  assert.match(system[0].text, /delegated work/);
  assert.match(system[0].text, /tests pass/);
  controller.dispose();
});

test("goal_set refuses to clobber an existing goal", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  const result = await harness.runTool("goal_set", { objective: "another goal" });
  assert.match(result.content, /already exists/);
  controller.dispose();
});

test("goal_clear tool defers to the user", async () => {
  const { harness, controller } = await setup();
  await harness.runCommand("fix tests");
  const result = await harness.runTool("goal_clear", {});
  assert.match(result.content, /reserved for the user/);
  const goal = await storeFor(harness).load("ses_main");
  assert.equal(goal.status, "active");
  controller.dispose();
});
