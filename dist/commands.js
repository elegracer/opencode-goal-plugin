/**
 * `/goal` argument parsing and human-readable status/history rendering.
 *
 * Simplified command surface: status, set, pause, resume, edit, block, done,
 * clear, history, task, help. A bare non-verb argument is treated as `set`.
 * Misspelled/unknown command words are rejected with a suggestion instead of
 * silently becoming a new goal.
 */
import { activeMsAt, statusLabel, taskSummary } from "./state.js";
import { formatClock, formatDuration, formatTokens, truncate } from "./util.js";
const VERB_ALIASES = {
    status: "status",
    set: "set",
    pause: "pause",
    resume: "resume",
    edit: "edit",
    block: "block",
    done: "done",
    clear: "clear",
    history: "history",
    task: "task",
    help: "help",
    // Common synonyms kept as verbs so they can never become goal text.
    complete: "done",
    cancel: "clear",
    stop: "pause",
    continue: "resume",
};
/** Commands that existed before the budget/cap removal; guide instead of creating a goal. */
const REMOVED_VERBS = {
    budget: "budget limits were removed — goals run until you pause/clear them",
    limits: "budget limits were removed — goals run until you pause/clear them",
    cap: "budget limits were removed — goals run until you pause/clear them",
    caps: "budget limits were removed — goals run until you pause/clear them",
    token: "budget limits were removed — goals run until you pause/clear them",
    tokens: "budget limits were removed — goals run until you pause/clear them",
    view: "use /goal status",
    tasks: "use /goal task list",
    log: "use /goal history",
    new: "use /goal set <objective>",
    create: "use /goal set <objective>",
    start: "use /goal set <objective>",
    update: "use /goal edit <objective>",
};
export function tokenize(input) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (const char of input) {
        if (quote) {
            if (char === quote)
                quote = null;
            else
                current += char;
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
    if (current)
        tokens.push(current);
    return tokens;
}
function parseFlags(tokens) {
    const words = [];
    const flags = {};
    const takeValue = (index, inline) => {
        if (inline !== undefined)
            return { value: inline, next: index };
        const value = tokens[index + 1];
        if (value === undefined || value.startsWith("--"))
            return { value: undefined, next: index };
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
        switch (name) {
            case "criteria": {
                const { value, next } = takeValue(i, inline);
                if (value === undefined)
                    return { words, flags, error: "--criteria requires quoted text" };
                flags.criteria = value;
                i = next;
                break;
            }
            case "constraints": {
                const { value, next } = takeValue(i, inline);
                if (value === undefined)
                    return { words, flags, error: "--constraints requires quoted text" };
                flags.constraints = value;
                i = next;
                break;
            }
            case "verify": {
                const { value, next } = takeValue(i, inline);
                if (value !== "evidence" && value !== "model") {
                    return { words, flags, error: "--verify must be evidence or model" };
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
function levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++)
        dp[i][0] = i;
    for (let j = 0; j < cols; j++)
        dp[0][j] = j;
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[rows - 1][cols - 1];
}
/** Find a near-miss command for a single typo (same first letter, distance 1). */
function suggestVerb(head) {
    if (!/^[a-z]+$/.test(head) || head.length < 3)
        return undefined;
    for (const verb of Object.keys(VERB_ALIASES)) {
        if (verb[0] !== head[0])
            continue;
        if (Math.abs(verb.length - head.length) > 1)
            continue;
        if (levenshtein(head, verb) <= 1)
            return verb;
    }
    return undefined;
}
export function parseGoalCommand(raw) {
    const tokens = tokenize(raw ?? "");
    const parsed = parseFlags(tokens);
    if (parsed.error)
        return { verb: "set", text: "", flags: parsed.flags, error: parsed.error };
    const words = parsed.words;
    if (words.length === 0)
        return { verb: "status", text: "", flags: parsed.flags };
    const head = words[0].toLowerCase();
    const tail = words.slice(1).join(" ");
    const verb = VERB_ALIASES[head];
    if (verb)
        return { verb, text: tail, flags: parsed.flags };
    const removed = REMOVED_VERBS[head];
    if (removed) {
        return {
            verb: "help",
            text: "",
            flags: parsed.flags,
            error: `"${words[0]}" is no longer a goal command — ${removed} (or use /goal set <objective>)`,
        };
    }
    // Typo guard: only when the rest is empty or flags (so real objectives like
    // "restore the backup" are still accepted).
    const onlyFlagsLeft = words.length === 1 || words.slice(1).every((word) => word.startsWith("--"));
    const suggestion = onlyFlagsLeft ? suggestVerb(head) : undefined;
    if (suggestion) {
        return {
            verb: "help",
            text: "",
            flags: parsed.flags,
            error: `unknown command "${words[0]}" — did you mean "${suggestion}"? To set a goal, use /goal set <objective>`,
        };
    }
    return { verb: "set", text: words.join(" "), flags: parsed.flags };
}
export function formatStatus(goal, candidates) {
    if (!goal) {
        return "No goal is set for this session. Use /goal <objective> to set one.";
    }
    const lines = [];
    lines.push(`🎯 ${truncate(goal.objective, 240)}`);
    lines.push(`Status: ${statusLabel(goal)}`);
    if (goal.criteria)
        lines.push(`Criteria: ${truncate(goal.criteria, 200)}`);
    if (goal.constraints)
        lines.push(`Constraints: ${truncate(goal.constraints, 200)}`);
    lines.push(`Used: turns ${goal.used.turns} · context ${formatTokens(goal.used.contextTokens)} · elapsed ${formatDuration(activeMsAt(goal, new Date().toISOString()))}`);
    if (goal.checkpoints.length) {
        const last = goal.checkpoints[goal.checkpoints.length - 1];
        lines.push(`Latest checkpoint: [${formatClock(last.at)}] ${truncate(last.summary, 160)}`);
    }
    if (goal.tasks?.length) {
        const summary = taskSummary(goal);
        lines.push(`Tasks: ${summary.done}/${summary.total} done${summary.doing ? `, ${summary.doing} in progress` : ""}`);
        for (const task of goal.tasks.filter((item) => item.status !== "done").slice(0, 3)) {
            lines.push(`- [${task.status}] ${task.id} ${truncate(task.title, 100)}`);
        }
    }
    if (candidates.length) {
        lines.push(`Evidence candidates: ${candidates
            .slice(-3)
            .map((candidate) => `${candidate.callID}`)
            .join(", ")}`);
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
export function formatHistory(goal) {
    if (!goal)
        return "No goal is set for this session.";
    const lines = [`Goal ${goal.goalID} — ${truncate(goal.objective, 160)}`];
    lines.push(`Status: ${statusLabel(goal)}`);
    lines.push("History:");
    for (const entry of goal.history.slice(-20)) {
        const detail = entry.detail ? ` — ${truncate(entry.detail, 140)}` : "";
        lines.push(`- [${formatClock(entry.at)}] ${entry.action}: ${entry.from} → ${entry.to}${detail}`);
    }
    if (goal.archive.length) {
        lines.push("Archived:");
        for (const archived of goal.archive.slice(-5)) {
            lines.push(`- ${truncate(archived.objective, 120)} (${archived.status}${archived.stopReason ? `: ${archived.stopReason}` : ""})`);
        }
    }
    return lines.join("\n");
}
export function formatTasks(goal) {
    if (!goal)
        return "No goal is set for this session.";
    if (!goal.tasks?.length) {
        return "No tasks yet. Add one with /goal task add <title>.";
    }
    const summary = taskSummary(goal);
    const lines = [`Tasks: ${summary.done}/${summary.total} done${summary.doing ? `, ${summary.doing} in progress` : ""}`];
    for (const task of goal.tasks) {
        lines.push(`- [${task.status}] ${task.id} ${truncate(task.title, 160)}`);
    }
    return lines.join("\n");
}
export function commandHelp(commandName) {
    return [
        `/${commandName} <objective> — set a goal and start working toward it`,
        `/${commandName} status — show the current goal (default)`,
        `/${commandName} pause | resume — stop or re-arm automatic continuation`,
        `/${commandName} edit <objective> — revise the objective in place`,
        `/${commandName} block <reason> — record a specific blocker`,
        `/${commandName} done <evidence> — complete with a checkable evidence summary`,
        `/${commandName} clear — archive and clear the current goal`,
        `/${commandName} history — lifecycle history and archive`,
        `/${commandName} task add <title> — add a task`,
        `/${commandName} task <ref> todo|doing|done — update a task (ref = id or number)`,
        `/${commandName} task list — list tasks`,
        `/${commandName} help — this help`,
        "",
        'Flags for set: --criteria "..." --constraints "..." --verify evidence|model',
        "Goals run until you pause/clear them; there are no automatic budget limits.",
    ].join("\n");
}
