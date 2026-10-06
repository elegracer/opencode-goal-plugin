/**
 * Agent-facing goal tools (registered through `ctx.tool.transform`).
 *
 * Only the `goal_*` tools and the `/goal` command mutate goal state. The
 * completion path always goes through the same evidence gate as the command
 * path.
 */
export function goalToolDefinitions(api) {
    return [
        {
            name: "goal_get",
            description: "Get the persisted session goal: status, budget usage, checkpoints, history, and the exact evidence candidate IDs " +
                "that goal_update complete must reference. Read-only.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, context) => ({ content: await api.goalStatusJSON(context.sessionID) }),
        },
        {
            name: "goal_set",
            description: "Create a session goal. Call this ONLY when the user explicitly asks to set a goal; never create goals on your own " +
                "initiative. Fails when a goal already exists.",
            input: {
                type: "object",
                properties: {
                    objective: { type: "string", minLength: 1, description: "What must be achieved." },
                    criteria: { type: "string", description: "Optional concrete success criteria." },
                    constraints: { type: "string", description: "Optional constraints / non-goals." },
                    unbounded: { type: "boolean", description: "Explicitly disable numeric caps (turn/token/duration)." },
                    maxTurns: { type: "integer", minimum: 1 },
                    maxTokens: { type: "integer", minimum: 1 },
                    maxDurationMs: { type: "integer", minimum: 1 },
                },
                required: ["objective"],
                additionalProperties: false,
            },
            options: { codemode: false },
            execute: async (input, context) => {
                const value = input;
                const result = await api.goalSet(context.sessionID, value);
                return { content: result.message };
            },
        },
        {
            name: "goal_update",
            description: 'Update the session goal. Actions: "pause", "resume", "block" (requires a specific blocker), and "complete" ' +
                '(requires structured evidence: a candidateID from goal_get plus a specific summary; completion is independently ' +
                "verified). Never mark a goal complete without evidence.",
            input: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["pause", "resume", "block", "complete"] },
                    blocker: { type: "string", minLength: 1, description: "Required for action=block." },
                    evidence: {
                        type: "object",
                        properties: {
                            candidateID: { type: "string", description: "Exact evidence candidate ID returned by goal_get." },
                            summary: {
                                type: "string",
                                minLength: 24,
                                description: "What was verified: commands run, results, files checked.",
                            },
                        },
                        required: ["candidateID", "summary"],
                        additionalProperties: false,
                    },
                },
                required: ["action"],
                additionalProperties: false,
            },
            options: { codemode: false },
            execute: async (input, context) => {
                const value = input;
                const result = await api.goalUpdate(context.sessionID, value);
                return { content: result.message };
            },
        },
        {
            name: "goal_add_task",
            description: "Add a task to the active goal's task list so progress is visible and survives compaction. Use for multi-step goals.",
            input: {
                type: "object",
                properties: { title: { type: "string", minLength: 1, description: "Short task title." } },
                required: ["title"],
                additionalProperties: false,
            },
            options: { codemode: false },
            execute: async (input, context) => {
                const value = input;
                const result = await api.goalTaskAdd(context.sessionID, value.title);
                return { content: result.message };
            },
        },
        {
            name: "goal_update_task",
            description: "Update a goal task's status. `ref` is the task id (t1) or its 1-based position.",
            input: {
                type: "object",
                properties: {
                    ref: { type: "string", minLength: 1, description: "Task id or 1-based index." },
                    status: { type: "string", enum: ["todo", "doing", "done"] },
                },
                required: ["ref", "status"],
                additionalProperties: false,
            },
            options: { codemode: false },
            execute: async (input, context) => {
                const value = input;
                const result = await api.goalTaskUpdate(context.sessionID, value.ref, value.status);
                return { content: result.message };
            },
        },
        {
            name: "goal_history",
            description: "Get the session goal lifecycle history and archived goals. Read-only.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, context) => ({ content: await api.goalHistoryJSON(context.sessionID) }),
        },
        {
            name: "goal_clear",
            description: "Clearing a goal is reserved for the user's own command (/goal clear). Do not call this tool; ask the user to clear it.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, context) => {
                const result = await api.goalClear(context.sessionID);
                return { content: result.message };
            },
        },
    ];
}
