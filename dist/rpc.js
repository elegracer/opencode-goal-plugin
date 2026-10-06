/**
 * RPC contract for the goal plugin (`goals.get` + `goals.updated`).
 *
 * `Rpc.define` is an identity helper, so the definition is a plain object and
 * the package keeps zero runtime dependencies. The TUI plugin imports this
 * module to build its client with `context.client.rpc(GoalRpc)`; the server
 * registers the same definition through `ctx.rpc.register`.
 */
export const GoalRpc = {
    id: "goal",
    methods: {
        get: {
            input: {
                type: "object",
                properties: { sessionID: { type: "string" } },
                required: ["sessionID"],
                additionalProperties: false,
            },
            output: {
                type: "object",
                properties: { payload: { type: "string" } },
                required: ["payload"],
                additionalProperties: false,
            },
        },
    },
    events: {
        updated: {
            schema: {
                type: "object",
                properties: { sessionID: { type: "string" } },
                required: ["sessionID"],
                additionalProperties: false,
            },
        },
    },
};
