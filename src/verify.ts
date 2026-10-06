/**
 * Completion verification tiers.
 *
 * - "evidence": structural gate only (candidate reference + summary quality).
 * - "model": one independent, tool-less model call adjudicates the claim.
 *
 * All failures are fail-closed unless the verifier model is implicit and the
 * host refuses the call (then the evidence gate applies with the degradation
 * recorded).
 */

import type { PluginContext } from "./api.js";
import type { EvidenceCandidate, GoalRecord } from "./types.js";
import { parseVerdict, completionReviewPrompt } from "./prompts.js";
import { errorText, isRecord } from "./util.js";

export interface VerifyInput {
  goal: GoalRecord;
  candidate: EvidenceCandidate;
  summary: string;
  transcript: string;
  /** Already resolved verifier model (explicit option, session model, or host default). */
  verifierModel?: { providerID: string; id: string; variant?: string };
  /** True when the user explicitly configured `verifierModel`. */
  verifierExplicit: boolean;
}

export interface VerifyDecision {
  approved: boolean;
  tier: string;
  reason: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`verification timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Tolerant transcript extraction from `session.context()` results. */
export function extractTranscript(messages: ReadonlyArray<unknown>, maxChars: number): string {
  const parts: string[] = [];
  for (const message of messages) {
    const text = extractMessageText(message);
    if (text) parts.push(text);
  }
  const joined = parts.join("\n---\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!isRecord(message)) return "";
  const direct = typeof message.text === "string" ? message.text : "";
  const content = Array.isArray(message.content) ? message.content : [];
  const contentText = content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const partsText = parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  return [direct, contentText, partsText].filter(Boolean).join("\n");
}

export async function verifyCompletion(
  ctx: PluginContext,
  verification: "evidence" | "model",
  verifierTimeoutMs: number,
  input: VerifyInput,
): Promise<VerifyDecision> {
  if (verification === "evidence") {
    return { approved: true, tier: "evidence", reason: "evidence accepted" };
  }

  const model = input.verifierModel;
  if (!model) {
    // No model available to adjudicate: accept the evidence gate, but make
    // the degradation visible in the audit trail.
    return { approved: true, tier: "evidence (no verifier model)", reason: "verifier model unavailable" };
  }
  try {
    const prompt = completionReviewPrompt(input);
    const result = await withTimeout(ctx.generate.text({ model, prompt }), verifierTimeoutMs);
    const verdict = parseVerdict(result?.text);
    if (!verdict) {
      return { approved: false, tier: "model", reason: "verifier returned an unparsable verdict" };
    }
    return { approved: verdict.approved, tier: "model", reason: verdict.reason };
  } catch (error) {
    if (input.verifierExplicit) {
      return { approved: false, tier: "model", reason: `verifier failed: ${errorText(error)}` };
    }
    // Implicit verifier (session or host default model): a host restriction
    // such as a free-tier limit must not wedge the goal. Degrade to the
    // evidence gate and record the degradation.
    return {
      approved: true,
      tier: "evidence (verifier unavailable)",
      reason: `verifier call failed: ${errorText(error)}`,
    };
  }
}
