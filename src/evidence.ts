/**
 * Evidence tracking and structural completion gating.
 *
 * The model cannot complete a goal by prose alone:
 * 1. The plugin records every successful tool call as an evidence candidate
 *    (`tool.hook("execute.after")`), keyed by the real tool call ID.
 * 2. `goal_update { action: "complete" }` must reference one of those IDs.
 * 3. The summary must be specific (length + a checkable anchor).
 * 4. An optional independent verifier (model or agent tier) has the final say.
 *
 * Candidates are in-memory only: after a restart the model must produce fresh
 * evidence, which is the conservative behavior.
 */

import type { EvidenceCandidate } from "./types.js";
import { isRecord, truncate } from "./util.js";

export const MIN_EVIDENCE_SUMMARY = 24;

const ANCHOR_PATTERN =
  /(\/|\d|\.\w{2,})\S*/; // path, number, or file extension anywhere

const ANCHOR_KEYWORDS = new Set([
  "file",
  "files",
  "test",
  "tests",
  "pass",
  "passed",
  "fail",
  "failed",
  "output",
  "verified",
  "verify",
  "created",
  "exists",
  "contains",
  "commit",
  "log",
  "result",
  "results",
  "content",
  "checked",
  "measured",
  "build",
  "suite",
  "exit",
  "passing",
]);

function hasAnchor(text: string): boolean {
  if (ANCHOR_PATTERN.test(text)) return true;
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => ANCHOR_KEYWORDS.has(word));
}

/** Returns a human-readable rejection reason, or undefined when acceptable. */
export function evidenceQuality(summary: string): string | undefined {
  const text = (summary ?? "").trim();
  if (!text) {
    return "evidence summary is required and must describe something checkable";
  }
  if (text.length < MIN_EVIDENCE_SUMMARY) {
    return `evidence is too weak (${text.length} chars, minimum ${MIN_EVIDENCE_SUMMARY})`;
  }
  if (!hasAnchor(text)) {
    return "evidence has no checkable anchor (path, number, test result, or command output)";
  }
  return undefined;
}

const PROGRESS_TOOLS = new Set(["edit", "write", "patch"]);

export class EvidenceTracker {
  private readonly bySession = new Map<string, EvidenceCandidate[]>();
  private readonly limit: number;

  constructor(limit = 20) {
    this.limit = limit;
  }

  record(sessionID: string, candidate: EvidenceCandidate): void {
    const list = this.bySession.get(sessionID) ?? [];
    if (!list.some((item) => item.callID === candidate.callID)) {
      list.push(candidate);
      if (list.length > this.limit) list.splice(0, list.length - this.limit);
    }
    this.bySession.set(sessionID, list);
  }

  list(sessionID: string): EvidenceCandidate[] {
    return [...(this.bySession.get(sessionID) ?? [])];
  }

  has(sessionID: string, callID: string): boolean {
    return (this.bySession.get(sessionID) ?? []).some((item) => item.callID === callID);
  }

  latest(sessionID: string): EvidenceCandidate | undefined {
    const list = this.bySession.get(sessionID) ?? [];
    return list.length ? list[list.length - 1] : undefined;
  }

  clear(sessionID: string): void {
    this.bySession.delete(sessionID);
  }

  clearAll(): void {
    this.bySession.clear();
  }
}

export function isProgressTool(tool: string): boolean {
  return PROGRESS_TOOLS.has(tool);
}

function partText(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  return typeof part.text === "string" ? part.text : undefined;
}

/** Best-effort summary of a tool result for checkpoint/evidence display. */
export function summarizeToolResult(tool: string, result: unknown): string {
  if (!isRecord(result)) return `${tool} completed`;
  const content = result.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part) => partText(part))
      .filter((value): value is string => Boolean(value))
      .join("\n");
  }
  if (!text && typeof result.output !== "undefined") {
    try {
      text = JSON.stringify(result.output);
    } catch {
      text = undefined;
    }
  }
  const firstLine = (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "";
  return truncate(firstLine.replace(/\s+/g, " "), 160) || `${tool} completed`;
}
