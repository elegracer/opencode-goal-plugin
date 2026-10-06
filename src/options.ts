/**
 * Plugin option resolution and validation.
 *
 * There are no budget caps: like Codex goal mode, a goal keeps running until
 * the user pauses/clears it or the model completes/blocks with evidence.
 * `verification` controls the completion gate.
 */

import { asNumber, asString, isRecord } from "./util.js";

export type VerificationTier = "evidence" | "model";

export interface ResolvedOptions {
  autoContinue: boolean;
  continuationIntervalMs: number;
  verification: VerificationTier;
  verifierModel?: { providerID: string; id: string; variant?: string };
  verifierTimeoutMs: number;
  onUserMessage: "pause" | "continue";
  maxPromptFailures: number;
  debug: boolean;
}

export const DEFAULTS: ResolvedOptions = {
  autoContinue: true,
  continuationIntervalMs: 1500,
  verification: "model",
  verifierTimeoutMs: 300_000,
  onUserMessage: "pause",
  maxPromptFailures: 3,
  debug: false,
};

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? asNumber(value) : undefined;
  if (number === undefined || number <= 0) return undefined;
  return number;
}

function parseVerifierModel(value: unknown): ResolvedOptions["verifierModel"] {
  if (typeof value === "string") {
    const [providerID, id, variant] = value.split("/");
    if (providerID && id) return { providerID, id, ...(variant ? { variant } : {}) };
    return undefined;
  }
  if (isRecord(value)) {
    const providerID = asString(value.providerID);
    const id = asString(value.id) ?? asString(value.modelID);
    const variant = asString(value.variant);
    if (providerID && id) return { providerID, id, ...(variant ? { variant } : {}) };
  }
  return undefined;
}

export function resolveOptions(raw: Record<string, unknown>): ResolvedOptions {
  const options: ResolvedOptions = { ...DEFAULTS };

  if (typeof raw.autoContinue === "boolean") options.autoContinue = raw.autoContinue;
  if (typeof raw.debug === "boolean") options.debug = raw.debug;

  const interval = positiveNumber(raw.continuationIntervalMs);
  if (interval !== undefined && interval >= 100) options.continuationIntervalMs = interval;

  const verification = asString(raw.verification);
  if (verification === "evidence" || verification === "model") options.verification = verification;

  const verifierModel = parseVerifierModel(raw.verifierModel);
  if (verifierModel) options.verifierModel = verifierModel;

  const verifierTimeout = positiveNumber(raw.verifierTimeoutMs);
  if (verifierTimeout !== undefined) options.verifierTimeoutMs = verifierTimeout;

  const onUserMessage = asString(raw.onUserMessage);
  if (onUserMessage === "pause" || onUserMessage === "continue") options.onUserMessage = onUserMessage;

  const maxFailures = positiveNumber(raw.maxPromptFailures);
  if (maxFailures !== undefined && Number.isInteger(maxFailures)) options.maxPromptFailures = maxFailures;

  return options;
}
