import test from "node:test";
import assert from "node:assert/strict";
import { ContinuationLoop } from "../dist/loop.js";

function makeDeps(overrides = {}) {
  const sent = [];
  const failures = [];
  const goal = { goalID: "g1", status: "active" };
  const deps = {
    canContinue: async () => goal,
    sendContinuation: async (sessionID, continuationGoal) => {
      sent.push({ sessionID, goal: continuationGoal });
      return true;
    },
    onPromptFailure: async (sessionID, error) => {
      failures.push({ sessionID, error });
    },
    log() {},
    ...overrides,
  };
  return { deps, sent, failures, goal };
}

test("busy sessions do not schedule; boundaries release the loop", async () => {
  const { deps, sent } = makeDeps();
  const loop = new ContinuationLoop(deps, 100);
  loop.noteExecutionStarted("s");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 0);

  const boundary = loop.noteBoundary("s", "evt_1", "execution");
  assert.equal(boundary.duplicate, false);
  assert.equal(boundary.wasGoalTurn, false);
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 1);
  loop.dispose();
});

test("duplicate boundary events only continue once", async () => {
  const { deps, sent } = makeDeps();
  const loop = new ContinuationLoop(deps, 100);
  loop.noteExecutionStarted("s");
  assert.equal(loop.noteBoundary("s", "evt_1", "execution").duplicate, false);
  assert.equal(loop.noteBoundary("s", "evt_1", "execution").duplicate, true);
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 1);
  loop.dispose();
});

test("a continuation turn is marked until its boundary settles", async () => {
  const { deps } = makeDeps();
  const loop = new ContinuationLoop(deps, 100);
  loop.noteExecutionStarted("s");
  loop.noteBoundary("s", "evt_1", "execution");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  loop.noteExecutionStarted("s");
  const boundary = loop.noteBoundary("s", "evt_2", "execution");
  assert.equal(boundary.wasGoalTurn, true);
  loop.dispose();
});

test("retrying sessions are suppressed until execution restarts", async () => {
  const { deps, sent } = makeDeps();
  const loop = new ContinuationLoop(deps, 100);
  loop.noteBoundary("s", "evt_1", "execution");
  loop.noteRetryScheduled("s");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 0);
  loop.noteExecutionStarted("s");
  loop.noteBoundary("s", "evt_2", "execution");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 1);
  loop.dispose();
});

test("prompt failures surface to the caller", async () => {
  const { deps, failures } = makeDeps({
    sendContinuation: async () => {
      throw new Error("prompt rejected");
    },
  });
  const loop = new ContinuationLoop(deps, 100);
  loop.noteBoundary("s", "evt_1", "execution");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].error), /prompt rejected/);
  loop.dispose();
});

test("cancel prevents a scheduled continuation", async () => {
  const { deps, sent } = makeDeps();
  const loop = new ContinuationLoop(deps, 150);
  loop.noteBoundary("s", "evt_1", "execution");
  await loop.schedule("s");
  loop.cancel("s");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(sent.length, 0);
  loop.dispose();
});

test("idle fallback is suppressed right after an execution boundary", async () => {
  const { deps } = makeDeps();
  const loop = new ContinuationLoop(deps, 100);
  loop.noteExecutionStarted("s");
  loop.noteBoundary("s", "evt_1", "execution");
  const idle = loop.noteBoundary("s", "evt_idle", "idle");
  assert.equal(idle.duplicate, true);
  loop.dispose();
});

test("idle is never authoritative once execution events are seen", async () => {
  const { deps } = makeDeps();
  const loop = new ContinuationLoop(deps, 100);
  loop.noteBoundary("s", "evt_1", "execution");
  const idle = loop.noteBoundary("s", "evt_idle", "idle");
  assert.equal(idle.duplicate, true);
  assert.equal(idle.wasGoalTurn, false);
  loop.dispose();
});

test("a skipped continuation does not count as sent and stays retryable", async () => {
  let attempts = 0;
  const { deps, failures } = makeDeps({
    sendContinuation: async () => {
      attempts += 1;
      return false;
    },
  });
  const loop = new ContinuationLoop(deps, 100);
  loop.noteBoundary("s", "evt_1", "execution");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(attempts, 1);
  assert.equal(failures.length, 0);

  loop.noteBoundary("s", "evt_2", "execution");
  await loop.schedule("s");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(attempts, 2);
  loop.dispose();
});
