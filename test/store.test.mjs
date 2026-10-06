import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { GoalStore } from "../dist/store.js";
import { startGoal } from "../dist/state.js";

function makeGoal(sessionID = "s1") {
  return startGoal(undefined, {
    sessionID,
    projectID: "p1",
    locationDirectory: "/d1",
    objective: "cross-location lookup",
    limits: {},
    unbounded: false,
    at: new Date().toISOString(),
  });
}

test("store persists per scope and indexes sessions across scopes", async () => {
  const h = createHarness();
  const scopeA = new GoalStore(h.ctx.storage, { projectID: "p1", directory: "/d1" });
  const scopeB = new GoalStore(h.ctx.storage, { projectID: "p2", directory: "/d2" });
  const goal = makeGoal("s1");
  await scopeA.mutate("s1", () => goal);

  assert.equal((await scopeA.load("s1"))?.goalID, goal.goalID);
  assert.equal(await scopeB.load("s1"), undefined);
  assert.equal((await scopeB.loadByIndex("s1"))?.goalID, goal.goalID);

  await scopeA.mutate("s1", () => undefined);
  assert.equal(await scopeB.loadByIndex("s1"), undefined);
});

test("ensureIndex backfills records saved before the index existed", async () => {
  const h = createHarness();
  const scopeA = new GoalStore(h.ctx.storage, { projectID: "p1", directory: "/d1" });
  const scopeB = new GoalStore(h.ctx.storage, { projectID: "p2", directory: "/d2" });
  const goal = makeGoal("s2");
  await scopeA.mutate("s2", () => goal);

  await h.ctx.storage.remove(scopeA.indexKey("s2"));
  assert.equal(await scopeB.loadByIndex("s2"), undefined);

  await scopeA.ensureIndex(goal);
  assert.equal((await scopeB.loadByIndex("s2"))?.goalID, goal.goalID);
});

test("claims are namespaced per session and purpose", async () => {
  const h = createHarness();
  const store = new GoalStore(h.ctx.storage, { projectID: "p1", directory: "/d1" });
  assert.notEqual(store.claimKey("s1", "continuation"), store.claimKey("s1", "wrapup"));
  assert.notEqual(store.claimKey("s1", "continuation"), store.claimKey("s2", "continuation"));
});
