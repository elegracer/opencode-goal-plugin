/**
 * Completion verification tiers.
 *
 * - "evidence": structural gate only (candidate reference + summary quality).
 * - "model": one independent, tool-less model call adjudicates the claim.
 * - "agent": a bounded child session inspects the workspace and executes
 *   non-destructive checks, then reports a verdict.
 *
 * All failures are fail-closed: an unparsable or failed verification rejects
 * the completion and the goal is paused with the reason, never silently
 * completed.
 */
import { parseVerdict } from "./prompts.js";
import { completionReviewPrompt, agentVerifierPrompt } from "./prompts.js";
import { errorText, isRecord } from "./util.js";
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`verification timed out after ${ms}ms`)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
/** Tolerant transcript extraction from `session.context()` results. */
export function extractTranscript(messages, maxChars) {
    const parts = [];
    for (const message of messages) {
        const text = extractMessageText(message);
        if (text)
            parts.push(text);
    }
    const joined = parts.join("\n---\n");
    return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
function extractMessageText(message) {
    if (typeof message === "string")
        return message;
    if (!isRecord(message))
        return "";
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
export async function verifyCompletion(ctx, verification, verifierModel, verifierTimeoutMs, input) {
    if (verification === "evidence") {
        return { approved: true, tier: "evidence", reason: "evidence accepted" };
    }
    if (verification === "model") {
        const model = verifierModel ?? input.sessionModel;
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
        }
        catch (error) {
            return { approved: false, tier: "model", reason: `verifier failed: ${errorText(error)}` };
        }
    }
    // Agent tier: an independent child session inspects the workspace.
    let childID;
    try {
        const child = await ctx.session.create({
            parentID: input.goal.sessionID,
            title: "Goal verification",
            metadata: { "opencode.goal.verifier": true },
        });
        childID = (child?.id ?? child?.sessionID);
        if (!childID) {
            return { approved: false, tier: "agent", reason: "could not create the verification session" };
        }
        await ctx.session.prompt({
            sessionID: childID,
            text: agentVerifierPrompt(input),
            metadata: { "opencode.goal.internal": true },
        });
        await withTimeout(ctx.session.wait({ sessionID: childID }), verifierTimeoutMs);
        const messages = await ctx.session.context({ sessionID: childID });
        const transcript = extractTranscript(messages, 16_000);
        const verdict = parseVerdict(transcript);
        if (!verdict) {
            return { approved: false, tier: "agent", reason: "verifier session returned no verdict" };
        }
        return { approved: verdict.approved, tier: "agent", reason: verdict.reason };
    }
    catch (error) {
        return { approved: false, tier: "agent", reason: `verifier failed: ${errorText(error)}` };
    }
    finally {
        if (childID) {
            try {
                await ctx.session.interrupt({ sessionID: childID });
            }
            catch {
                // ignore
            }
            try {
                await ctx.session.remove({ sessionID: childID });
            }
            catch {
                // ignore
            }
        }
    }
}
