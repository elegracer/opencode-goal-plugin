/**
 * RPC contract for the goal plugin (`goals.get` + `goals.updated`).
 *
 * `Rpc.define` is an identity helper, so the definition is a plain object and
 * the package keeps zero runtime dependencies. The TUI plugin imports this
 * module to build its client with `context.client.rpc(GoalRpc)`; the server
 * registers the same definition through `ctx.rpc.register`.
 */

export interface GoalRpcSnapshot {
  present: boolean;
  objective?: string;
  status?: string;
  stopReason?: string;
  recovered?: boolean;
  used?: { turns: number; contextTokens: number; burnTokens: number; cost: number };
  activeMs?: number;
  tasks?: { total: number; done: number; doing: number };
  taskItems?: Array<{ id: string; title: string; status: "todo" | "doing" | "done" }>;
  evidenceCount?: number;
  updatedAt?: string;
}

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
} as const;
