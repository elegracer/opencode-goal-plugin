import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceTracker, evidenceQuality, summarizeToolResult } from "../dist/evidence.js";

test("evidenceQuality rejects short or anchorless summaries", () => {
  assert.ok(evidenceQuality("done"));
  assert.ok(evidenceQuality("everything works now and all is well"));
  assert.equal(evidenceQuality("npm test passed: 42/42 tests, see /work/log.txt"), undefined);
});

test("evidence tracker records unique call ids per session", () => {
  const tracker = new EvidenceTracker(3);
  tracker.record("a", { callID: "call_1", tool: "shell", summary: "tests", at: "t", progress: false });
  tracker.record("a", { callID: "call_1", tool: "shell", summary: "tests again", at: "t", progress: false });
  tracker.record("a", { callID: "call_2", tool: "edit", summary: "edit", at: "t", progress: true });
  tracker.record("a", { callID: "call_3", tool: "edit", summary: "edit", at: "t", progress: true });
  tracker.record("a", { callID: "call_4", tool: "edit", summary: "edit", at: "t", progress: true });
  assert.deepEqual(
    tracker.list("a").map((item) => item.callID),
    ["call_2", "call_3", "call_4"],
  );
  assert.equal(tracker.has("a", "call_1"), false);
  assert.equal(tracker.latest("a").callID, "call_4");
  tracker.clear("a");
  assert.equal(tracker.list("a").length, 0);
});

test("summarizeToolResult prefers content text", () => {
  assert.equal(summarizeToolResult("shell", { content: "42 passing (1s)" }), "42 passing (1s)");
  assert.equal(
    summarizeToolResult("shell", { content: [{ type: "text", text: "first line\nsecond line" }] }),
    "first line",
  );
  assert.equal(summarizeToolResult("edit", { output: { path: "/a/b.ts" } }), '{"path":"/a/b.ts"}');
  assert.equal(summarizeToolResult("weird", {}), "weird completed");
});
