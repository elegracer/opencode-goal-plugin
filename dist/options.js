/**
 * Plugin option resolution and validation.
 *
 * Options come from the `plugins` entry object form:
 *   { "package": "opencode-goal-plugin", "options": { ... } }
 *
 * The defaults are intentionally safe: auto-continuation bounded by turn,
 * token, and wall-clock caps; completion gated by an independent model check
 * when a model is available.
 */
import { asNumber, asString, isRecord, parseAmount } from "./util.js";
export const DEFAULTS = {
    autoContinue: true,
    continuationIntervalMs: 1500,
    defaultLimits: {
        maxTurns: 10,
        maxTokens: 100_000,
        maxDurationMs: 30 * 60_000,
        noToolCallTurns: 2,
        noProgressTurns: 0,
    },
    unboundedByDefault: false,
    verification: "model",
    verifierTimeoutMs: 300_000,
    onUserMessage: "pause",
    wrapUpOnLimit: true,
    commandName: "goal",
    contextInjectionMaxChars: 4_000,
    maxPromptFailures: 3,
    stallOutputTokens: 50,
    debug: false,
};
function nonNegativeNumber(value) {
    if (typeof value === "string") {
        const parsed = parseAmount(value);
        return parsed;
    }
    const number = asNumber(value);
    if (number === undefined || number < 0)
        return undefined;
    return number;
}
function positiveInteger(value) {
    const number = nonNegativeNumber(value);
    if (number === undefined || number <= 0 || !Number.isInteger(number))
        return undefined;
    return number;
}
function parseVerifierModel(value) {
    if (typeof value === "string") {
        const [providerID, id, variant] = value.split("/");
        if (providerID && id)
            return { providerID, id, ...(variant ? { variant } : {}) };
        return undefined;
    }
    if (isRecord(value)) {
        const providerID = asString(value.providerID);
        const id = asString(value.id) ?? asString(value.modelID);
        const variant = asString(value.variant);
        if (providerID && id)
            return { providerID, id, ...(variant ? { variant } : {}) };
    }
    return undefined;
}
function parseVerification(value) {
    const text = asString(value);
    if (text === "evidence" || text === "model" || text === "agent")
        return text;
    return undefined;
}
export function resolveOptions(raw) {
    const options = {
        ...DEFAULTS,
        defaultLimits: { ...DEFAULTS.defaultLimits },
    };
    const bool = (key, target) => {
        const value = raw[key];
        if (typeof value === "boolean")
            target(value);
    };
    bool("autoContinue", (value) => (options.autoContinue = value));
    bool("wrapUpOnLimit", (value) => (options.wrapUpOnLimit = value));
    bool("debug", (value) => (options.debug = value));
    const interval = nonNegativeNumber(raw.continuationIntervalMs);
    if (interval !== undefined && interval >= 100)
        options.continuationIntervalMs = interval;
    const verification = parseVerification(raw.verification);
    if (verification)
        options.verification = verification;
    const verifierModel = parseVerifierModel(raw.verifierModel);
    if (verifierModel)
        options.verifierModel = verifierModel;
    const verifierTimeout = positiveInteger(raw.verifierTimeoutMs);
    if (verifierTimeout !== undefined)
        options.verifierTimeoutMs = verifierTimeout;
    const onUserMessage = asString(raw.onUserMessage);
    if (onUserMessage === "pause" || onUserMessage === "continue")
        options.onUserMessage = onUserMessage;
    const commandName = asString(raw.commandName);
    if (commandName && /^[a-z0-9][a-z0-9-_]*$/i.test(commandName))
        options.commandName = commandName.replace(/^\/+/, "");
    const maxChars = positiveInteger(raw.contextInjectionMaxChars);
    if (maxChars !== undefined)
        options.contextInjectionMaxChars = maxChars;
    const maxFailures = positiveInteger(raw.maxPromptFailures);
    if (maxFailures !== undefined)
        options.maxPromptFailures = maxFailures;
    const stallTokens = nonNegativeNumber(raw.stallOutputTokens);
    if (stallTokens !== undefined && stallTokens > 0)
        options.stallOutputTokens = stallTokens;
    // Default limits. `false`/`null` disables a specific cap; a number overrides it.
    const limit = (key, apply) => {
        if (!(key in raw))
            return;
        const value = raw[key];
        if (value === false || value === null) {
            apply(undefined);
            return;
        }
        const number = nonNegativeNumber(value);
        if (number !== undefined)
            apply(number);
    };
    limit("maxTurns", (value) => (options.defaultLimits.maxTurns = value));
    limit("maxTokens", (value) => (options.defaultLimits.maxTokens = value));
    limit("maxDurationMs", (value) => (options.defaultLimits.maxDurationMs = value));
    limit("noToolCallTurns", (value) => (options.defaultLimits.noToolCallTurns = value));
    limit("noProgressTurns", (value) => (options.defaultLimits.noProgressTurns = value));
    const minutes = nonNegativeNumber(raw.maxMinutes);
    if (minutes !== undefined && minutes > 0)
        options.defaultLimits.maxDurationMs = Math.round(minutes * 60_000);
    const unbounded = raw.unbounded;
    if (typeof unbounded === "boolean")
        options.unboundedByDefault = unbounded;
    return options;
}
