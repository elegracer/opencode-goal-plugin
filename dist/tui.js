// @bun
// src/tui.tsx
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
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
var OBJECTIVE_MAX = 72;
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
function formatTokens(count) {
  if (!Number.isFinite(count) || count < 0)
    return "?";
  if (count >= 1e6)
    return `${(count / 1e6).toFixed(1)}m`;
  if (count >= 1000)
    return `${Math.round(count / 1000)}k`;
  return String(Math.round(count));
}
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours > 0)
    return `${hours}h${minutes}m`;
  if (minutes > 0)
    return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
function usageLine(goal) {
  const used = goal.used ?? {
    turns: 0,
    contextTokens: 0,
    burnTokens: 0,
    cost: 0
  };
  return `turns ${used.turns} \xB7 ctx ${formatTokens(used.contextTokens)} \xB7 ${formatDuration(goal.activeMs ?? 0)}`;
}
function GoalSidebar(props) {
  const [goal, setGoal] = createSignal(undefined);
  let client;
  try {
    client = props.context.client.rpc(GoalRpc);
  } catch {
    client = undefined;
  }
  const refresh = async (sessionID) => {
    if (!client || !sessionID) {
      setGoal(undefined);
      return;
    }
    try {
      const result = await client.get({
        sessionID
      });
      const payload = typeof result?.payload === "string" ? JSON.parse(result.payload) : undefined;
      setGoal(payload && payload.present ? payload : undefined);
    } catch {
      setGoal(undefined);
    }
  };
  createEffect(() => {
    refresh(props.sessionID);
  });
  if (client?.events?.on) {
    const unsubscribe = client.events.on("updated", (event) => {
      if (event?.data?.sessionID === props.sessionID)
        refresh(props.sessionID);
    });
    onCleanup(() => {
      try {
        unsubscribe?.();
      } catch {}
    });
  }
  return _$createComponent(Show, {
    get when() {
      return goal();
    },
    children: (current) => (() => {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("text"), _el$4 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$insertNode(_el$, _el$3);
      _$insertNode(_el$, _el$4);
      _$setProp(_el$, "flexDirection", "column");
      _$insert(_el$2, () => `\uD83C\uDFAF Goal \xB7 ${current().status}`);
      _$insert(_el$3, () => truncate(current().objective ?? "", OBJECTIVE_MAX));
      _$insert(_el$4, () => usageLine(current()));
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return (current().tasks?.total ?? 0) > 0;
        },
        get children() {
          return [(() => {
            var _el$5 = _$createElement("text");
            _$insert(_el$5, () => `Tasks ${current().tasks?.done ?? 0}/${current().tasks?.total ?? 0}`);
            return _el$5;
          })(), _$createComponent(For, {
            get each() {
              return (current().taskItems ?? []).filter((task) => task.status !== "done").slice(0, 4);
            },
            children: (task) => (() => {
              var _el$6 = _$createElement("text");
              _$insert(_el$6, () => `- [${task.status}] ${truncate(task.title, 44)}`);
              return _el$6;
            })()
          })];
        }
      }), null);
      return _el$;
    })()
  });
}
var tui_default = {
  id: "opencode-goal.tui",
  setup(context) {
    let release;
    try {
      release = context?.ui?.slot?.({
        append: "sidebar.content",
        render: ({
          sessionID
        }) => _$createComponent(GoalSidebar, {
          context,
          sessionID
        })
      });
    } catch {
      return;
    }
    return () => {
      try {
        release?.();
      } catch {}
    };
  }
};
export {
  tui_default as default
};
