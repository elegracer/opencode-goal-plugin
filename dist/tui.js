// src/tui.tsx
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

// src/rpc.ts
var GoalRpc = {
  id: "goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { payload: { type: "string" } },
        required: ["payload"],
        additionalProperties: false
      }
    }
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      }
    }
  }
};

// src/tui.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var OBJECTIVE_MAX = 72;
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
function formatTokens(count) {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}m`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}k`;
  return String(Math.round(count));
}
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1e3));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
function budgetLine(goal) {
  const limits = goal.limits ?? {};
  const used = goal.used ?? { turns: 0, contextTokens: 0, burnTokens: 0, cost: 0 };
  const parts = [];
  if (!limits.unbounded && typeof limits.maxTurns === "number") parts.push(`turns ${used.turns}/${limits.maxTurns}`);
  else parts.push(`turns ${used.turns}`);
  if (!limits.unbounded && typeof limits.maxTokens === "number") {
    parts.push(`ctx ${formatTokens(used.contextTokens)}/${formatTokens(limits.maxTokens)}`);
  } else {
    parts.push(`ctx ${formatTokens(used.contextTokens)}`);
  }
  if (!limits.unbounded && typeof limits.maxDurationMs === "number") {
    parts.push(`${formatDuration(goal.activeMs ?? 0)}/${formatDuration(limits.maxDurationMs)}`);
  } else {
    parts.push(formatDuration(goal.activeMs ?? 0));
  }
  return parts.join(" \xB7 ");
}
function GoalSidebar(props) {
  const [goal, setGoal] = createSignal(void 0);
  let client;
  try {
    client = props.context.client.rpc(GoalRpc);
  } catch {
    client = void 0;
  }
  const refresh = async (sessionID) => {
    if (!client || !sessionID) {
      setGoal(void 0);
      return;
    }
    try {
      const result = await client.get({ sessionID });
      const payload = typeof result?.payload === "string" ? JSON.parse(result.payload) : void 0;
      setGoal(payload && payload.present ? payload : void 0);
    } catch {
      setGoal(void 0);
    }
  };
  createEffect(() => {
    void refresh(props.sessionID);
  });
  if (client?.events?.on) {
    const unsubscribe = client.events.on("updated", (event) => {
      if (event?.data?.sessionID === props.sessionID) void refresh(props.sessionID);
    });
    onCleanup(() => {
      try {
        unsubscribe?.();
      } catch {
      }
    });
  }
  return /* @__PURE__ */ jsx(Show, { when: goal(), fallback: /* @__PURE__ */ jsx("text", { children: `GOAL-NOGOAL rpc=${String(Boolean(client))}` }), children: (current) => /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
    /* @__PURE__ */ jsx("text", { children: `\u{1F3AF} Goal \xB7 ${current().status}` }),
    /* @__PURE__ */ jsx("text", { children: truncate(current().objective ?? "", OBJECTIVE_MAX) }),
    /* @__PURE__ */ jsx("text", { children: budgetLine(current()) }),
    /* @__PURE__ */ jsxs(Show, { when: (current().tasks?.total ?? 0) > 0, children: [
      /* @__PURE__ */ jsx("text", { children: `Tasks ${current().tasks?.done ?? 0}/${current().tasks?.total ?? 0}` }),
      /* @__PURE__ */ jsx(For, { each: (current().taskItems ?? []).filter((task) => task.status !== "done").slice(0, 4), children: (task) => /* @__PURE__ */ jsx("text", { children: `- [${task.status}] ${truncate(task.title, 44)}` }) })
    ] })
  ] }) });
}
var tui_default = {
  id: "opencode-goal.tui",
  setup(context) {
    let release;
    try {
      release = context?.ui?.slot?.({
        append: "sidebar.content",
        render: ({ sessionID }) => /* @__PURE__ */ jsx(GoalSidebar, { context, sessionID })
      });
    } catch {
      return;
    }
    return () => {
      try {
        release?.();
      } catch {
      }
    };
  }
};
export {
  tui_default as default
};
