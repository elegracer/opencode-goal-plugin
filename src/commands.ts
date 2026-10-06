/**
 * `/goal` command parsing and human-readable status rendering (pure logic).
 */

import type { EvidenceCandidate, GoalRecord } from "./types.js";
import type { GoalLimits } from "./types.js";
import { activeMsAt, statusLabel } from "./state.js";
import { formatClock, formatDuration, formatTokens, parseAmount, truncate } from "./util.js";

export type GoalVerb =
  | "status"
  | "set"
  | "pause"
  | "resume"
  | "edit"
  | "block"
  | "done"
  | "clear"
  | "history"
  | "help";

const VERB_ALIASES: Record<string, GoalVerb> = {
  status: "status",
  view: "status",
  set: "set",
  create: "set",
  new: "set",
  start: "set",
  pause: "pause",
  stop: "pause",
  resume: "resume",
  continue: "resume",
  edit: "edit",
  update: "edit",
  block: "block",
  blocked: "block",
  done: "done",
  complete: "done",
  finish: "done",
  clear: "clear",
  cancel: "clear",
  reset: "clear",
  off: "clear",
  none: "clear",
  delete: "clear",
  history: "history",
  log: "history",
  help: "help",
};

export interface GoalFlags {
  maxTurns?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  unbounded?: boolean;
  criteria?: string;
  constraints?: string;
  verification?: "evidence" | "model" | "agent";
}

export interface ParsedGoalCommand {
  verb: GoalVerb;
  text: string;
  flags: GoalFlags;
  error?: string;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

interface FlagParseResult {
  words: string[];
  flags: GoalFlags;
  error?: string;
}

function parseFlags(tokens: string[]): FlagParseResult {
  const words: string[] = [];
  const flags: GoalFlags = {};

  const takeValue = (index: number, name: string, inline: string | undefined): { value?: string; next: number } => {
    if (inline !== undefined) return { value: inline, next: index };
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { value: undefined, next: index };
    }
    return { value, next: index + 1 };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
    const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

    const positive = (value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      const parsed = parseAmount(value);
      return parsed;
    };

    switch (name) {
      case "turns":
      case "max-turns": {
        const { value, next } = takeValue(i, name, inline);
        const parsed = positive(value);
        if (parsed === undefined) return { words, flags, error: `--${name} requires a positive number` };
        flags.maxTurns = parsed;
        i = next;
        break;
      }
      case "tokens":
      case "max-tokens":
      case "budget": {
        const { value, next } = takeValue(i, name, inline);
        const parsed = positive(value);
        if (parsed === undefined) return { words, flags, error: `--${name} requires a positive number (e.g. 100k)` };
        flags.maxTokens = parsed;
        i = next;
        break;
      }
      case "minutes": {
        const { value, next } = takeValue(i, name, inline);
        const parsed = positive(value);
        if (parsed === undefined) return { words, flags, error: "--minutes requires a positive number" };
        flags.maxDurationMs = Math.round(parsed * 60_000);
        i = next;
        break;
      }
      case "duration-ms": {
        const { value, next } = takeValue(i, name, inline);
        const parsed = positive(value);
        if (parsed === undefined) return { words, flags, error: "--duration-ms requires a positive number" };
        flags.maxDurationMs = parsed;
        i = next;
        break;
      }
      case "unbounded":
      case "no-cap":
      case "unlimited":
        flags.unbounded = true;
        break;
      case "criteria":
      case "success":
      case "success-criteria": {
        const { value, next } = takeValue(i, name, inline);
        if (value === undefined) return { words, flags, error: `--${name} requires quoted text` };
        flags.criteria = value;
        i = next;
        break;
      }
      case "constraints":
      case "non-goals": {
        const { value, next } = takeValue(i, name, inline);
        if (value === undefined) return { words, flags, error: `--${name} requires quoted text` };
        flags.constraints = value;
        i = next;
        break;
      }
      case "verify": {
        const { value, next } = takeValue(i, name, inline);
        if (value !== "evidence" && value !== "model" && value !== "agent") {
          return { words, flags, error: "--verify must be evidence, model, or agent" };
        }
        flags.verification = value;
        i = next;
        break;
      }
      default:
        return { words, flags, error: `unknown flag --${name}` };
    }
  }
  return { words, flags };
}

export function parseGoalCommand(raw: string): ParsedGoalCommand {
  const tokens = tokenize(raw ?? "");
  const parsed = parseFlags(tokens);
  if (parsed.error) return { verb: "set", text: "", flags: parsed.flags, error: parsed.error };

  const words = parsed.words;
  if (words.length === 0) return { verb: "status", text: "", flags: parsed.flags };

  const first = words[0].toLowerCase();
  const verb = VERB_ALIASES[first];
  if (!verb) {
    return { verb: "set", text: words.join(" "), flags: parsed.flags };
  }
  return { verb, text: words.slice(1).join(" "), flags: parsed.flags };
}

export function mergeLimits(base: GoalLimits, flags: GoalFlags): GoalLimits {
  const limits: GoalLimits = { ...base };
  if (flags.maxTurns !== undefined) limits.maxTurns = flags.maxTurns;
  if (flags.maxTokens !== undefined) limits.maxTokens = flags.maxTokens;
  if (flags.maxDurationMs !== undefined) limits.maxDurationMs = flags.maxDurationMs;
  return limits;
}

export function formatStatus(goal: GoalRecord | undefined, candidates: readonly EvidenceCandidate[]): string {
  if (!goal) {
    return "No goal is set for this session. Use /goal <objective> to set one.";
  }
  const lines: string[] = [];
  lines.push(`🎯 ${truncate(goal.objective, 240)}`);
  lines.push(`Status: ${statusLabel(goal)}`);
  if (goal.criteria) lines.push(`Criteria: ${truncate(goal.criteria, 200)}`);
  if (goal.constraints) lines.push(`Constraints: ${truncate(goal.constraints, 200)}`);

  const budget: string[] = [];
  if (goal.unbounded) {
    budget.push("caps: unbounded");
  } else {
    if (goal.limits.maxTurns !== undefined) budget.push(`turns ${goal.used.turns}/${goal.limits.maxTurns}`);
    if (goal.limits.maxTokens !== undefined)
      budget.push(`context ${formatTokens(goal.used.contextTokens)}/${formatTokens(goal.limits.maxTokens)}`);
    if (goal.limits.maxDurationMs !== undefined)
      budget.push(`elapsed ${formatDuration(activeMsAt(goal, new Date().toISOString()))}/${formatDuration(goal.limits.maxDurationMs)}`);
  }
  if (budget.length) lines.push(`Budget: ${budget.join(" · ")}`);

  if (goal.checkpoints.length) {
    const last = goal.checkpoints[goal.checkpoints.length - 1];
    lines.push(`Latest checkpoint: [${formatClock(last.at)}] ${truncate(last.summary, 160)}`);
  }
  if (candidates.length) {
    lines.push(
      `Evidence candidates: ${candidates
        .slice(-3)
        .map((candidate) => `${candidate.callID}`)
        .join(", ")}`,
    );
  }
  if (goal.evidence.length) {
    const last = goal.evidence[goal.evidence.length - 1];
    lines.push(`Accepted evidence: ${truncate(last.summary, 200)} (${last.tier})`);
  }
  if (goal.archive.length) {
    lines.push(`Archived goals: ${goal.archive.length}`);
  }
  return lines.join("\n");
}

export function formatHistory(goal: GoalRecord | undefined): string {
  if (!goal) return "No goal is set for this session.";
  const lines: string[] = [`Goal ${goal.goalID} — ${truncate(goal.objective, 160)}`];
  lines.push(`Status: ${statusLabel(goal)}`);
  lines.push("History:");
  for (const entry of goal.history.slice(-20)) {
    const detail = entry.detail ? ` — ${truncate(entry.detail, 140)}` : "";
    lines.push(`- [${formatClock(entry.at)}] ${entry.action}: ${entry.from} → ${entry.to}${detail}`);
  }
  if (goal.archive.length) {
    lines.push("Archived:");
    for (const archived of goal.archive.slice(-5)) {
      lines.push(
        `- ${truncate(archived.objective, 120)} (${archived.status}${archived.stopReason ? `: ${archived.stopReason}` : ""})`,
      );
    }
  }
  return lines.join("\n");
}

export function commandHelp(commandName: string): string {
  return [
    `/${commandName} <objective> — set a goal and start working toward it`,
    `/${commandName} status — show the current goal (default)`,
    `/${commandName} pause | resume — stop or re-arm automatic continuation`,
    `/${commandName} edit <objective> — revise the objective in place`,
    `/${commandName} block <reason> — record a specific blocker`,
    `/${commandName} done <evidence> — complete with a checkable evidence summary`,
    `/${commandName} clear — archive and clear the current goal`,
    `/${commandName} history — lifecycle history and archive`,
    "",
    "Flags for set: --turns N --tokens N --minutes N --unbounded --criteria \"...\" --constraints \"...\" --verify evidence|model|agent",
  ].join("\n");
}
