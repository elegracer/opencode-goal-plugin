import test from "node:test";
import assert from "node:assert/strict";
import { verifyCompletion } from "../dist/verify.js";
import { parseVerdict } from "../dist/prompts.js";

const goal = { sessionID: "ses_1", objective: "create the file", criteria: "file exists" };
const candidate = { callID: "call_1", tool: "shell", summary: "42 passing", at: "2026-01-01T00:00:00.000Z", progress: false };

function input(overrides = {}) {
  return {
    goal,
    candidate,
    summary: "npm test passed 42/42, output in /work/log.txt",
    transcript: "",
    verifierModel: { providerID: "test", id: "verifier" },
    verifierExplicit: true,
    ...overrides,
  };
}

function ctxWith(generate) {
  return { generate: { text: generate } };
}

test("evidence tier accepts without a model call", async () => {
  let called = false;
  const decision = await verifyCompletion(
    ctxWith(async () => {
      called = true;
      return { text: "APPROVE" };
    }),
    "evidence",
    1000,
    input(),
  );
  assert.equal(decision.approved, true);
  assert.equal(decision.tier, "evidence");
  assert.equal(called, false);
});

test("model tier approves on APPROVE", async () => {
  const decision = await verifyCompletion(
    ctxWith(async () => ({ text: "APPROVE\nclearly verified" })),
    "model",
    1000,
    input(),
  );
  assert.equal(decision.approved, true);
  assert.equal(decision.tier, "model");
  assert.match(decision.reason, /verified/);
});

test("model tier rejects on REJECT and on unparsable output", async () => {
  const rejected = await verifyCompletion(
    ctxWith(async () => ({ text: "REJECT\nThe second requirement is not verified." })),
    "model",
    1000,
    input(),
  );
  assert.equal(rejected.approved, false);
  assert.equal(rejected.tier, "model");

  const unparsable = await verifyCompletion(
    ctxWith(async () => ({ text: "I cannot tell" })),
    "model",
    1000,
    input(),
  );
  assert.equal(unparsable.approved, false);
  assert.match(unparsable.reason, /unparsable/);
});

test("explicit verifier failure is fail-closed", async () => {
  const decision = await verifyCompletion(
    ctxWith(async () => {
      throw new Error("free tier limit");
    }),
    "model",
    1000,
    input(),
  );
  assert.equal(decision.approved, false);
  assert.equal(decision.tier, "model");
  assert.match(decision.reason, /verifier failed/);
});

test("implicit verifier failure degrades to the evidence gate", async () => {
  const decision = await verifyCompletion(
    ctxWith(async () => {
      throw new Error("OpenCode's free tier can only be used from within OpenCode");
    }),
    "model",
    1000,
    input({ verifierExplicit: false }),
  );
  assert.equal(decision.approved, true);
  assert.equal(decision.tier, "evidence (verifier unavailable)");
  assert.match(decision.reason, /free tier/);
});

test("missing verifier model degrades to the evidence gate", async () => {
  const decision = await verifyCompletion(
    ctxWith(async () => ({ text: "APPROVE" })),
    "model",
    1000,
    input({ verifierModel: undefined }),
  );
  assert.equal(decision.approved, true);
  assert.equal(decision.tier, "evidence (no verifier model)");
});

test("parseVerdict accepts both formats", () => {
  assert.deepEqual(parseVerdict("APPROVE\nreason"), { approved: true, reason: "reason" });
  assert.deepEqual(parseVerdict("REJECT\nmissing tests"), { approved: false, reason: "missing tests" });
  assert.deepEqual(parseVerdict("some text\nVERDICT: APPROVED because x"), {
    approved: true,
    reason: "VERDICT: APPROVED because x",
  });
  assert.equal(parseVerdict("no verdict here"), undefined);
});

function agentCtx({ verdictText = "VERDICT: APPROVED looks good", waitDelay = 0, removed = [] } = {}) {
  return {
    session: {
      async create() {
        return { id: "child_1", sessionID: "child_1" };
      },
      async prompt() {},
      async wait() {
        if (waitDelay) await new Promise((resolve) => setTimeout(resolve, waitDelay));
      },
      async context() {
        return [{ text: verdictText }];
      },
      async interrupt() {},
      async remove({ sessionID }) {
        removed.push(sessionID);
      },
    },
    generate: { text: async () => ({ text: "" }) },
  };
}

test("agent tier approves on VERDICT: APPROVED and cleans up the child", async () => {
  const removed = [];
  const decision = await verifyCompletion(agentCtx({ removed }), "agent", 500, input());
  assert.equal(decision.approved, true);
  assert.equal(decision.tier, "agent");
  assert.deepEqual(removed, ["child_1"]);
});

test("agent tier rejects on a missing verdict and on timeout", async () => {
  const rejected = await verifyCompletion(agentCtx({ verdictText: "I could not verify" }), "agent", 500, input());
  assert.equal(rejected.approved, false);
  assert.equal(rejected.tier, "agent");
  assert.match(rejected.reason, /no verdict/);

  const timedOut = await verifyCompletion(
    agentCtx({ verdictText: "VERDICT: APPROVED", waitDelay: 300 }),
    "agent",
    50,
    input(),
  );
  assert.equal(timedOut.approved, false);
  assert.match(timedOut.reason, /timed out/);
});
