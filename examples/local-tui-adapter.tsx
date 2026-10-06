/** @jsxImportSource @opentui/solid */
/**
 * Local TUI adapter for opencode-goal-plugin.
 *
 * The host's TUI runtime (this config directory's Solid/OpenTUI instances)
 * renders this file, so signals and effects integrate with the renderer. The
 * server plugin (installed from the package) owns state; this adapter only
 * fetches snapshots through its `goals` RPC and renders the sidebar widget.
 *
 * Mirrors src/tui.tsx + src/rpc.ts from the package.
 */
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

const GoalRpc = {
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

const OBJECTIVE_MAX = 72;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(Math.round(count));
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

interface Snapshot {
  present: boolean;
  objective?: string;
  status?: string;
  used?: { turns: number; contextTokens: number };
  limits?: { unbounded?: boolean; maxTurns?: number; maxTokens?: number; maxDurationMs?: number };
  activeMs?: number;
  tasks?: { total: number; done: number; doing: number };
  taskItems?: Array<{ id: string; title: string; status: string }>;
}

function budgetLine(goal: Snapshot): string {
  const limits = goal.limits ?? {};
  const used = goal.used ?? { turns: 0, contextTokens: 0 };
  const parts: string[] = [];
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
  return parts.join(" · ");
}

function GoalSidebar(props: { context: any; sessionID: string }) {
  const [goal, setGoal] = createSignal<Snapshot | undefined>(undefined);

  let client: any;
  try {
    client = props.context.client.rpc(GoalRpc);
  } catch {
    client = undefined;
  }

  const refresh = async (sessionID: string): Promise<void> => {
    if (!client || !sessionID) {
      setGoal(undefined);
      return;
    }
    try {
      const result = await client.get({ sessionID });
      const payload = typeof result?.payload === "string" ? JSON.parse(result.payload) : undefined;
      setGoal(payload && payload.present ? (payload as Snapshot) : undefined);
    } catch {
      setGoal(undefined);
    }
  };

  createEffect(() => {
    void refresh(props.sessionID);
  });

  if (client?.events?.on) {
    const unsubscribe = client.events.on("updated", (event: any) => {
      if (event?.data?.sessionID === props.sessionID) void refresh(props.sessionID);
    });
    onCleanup(() => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    });
  }

  return (
    <Show when={goal()}>
      {(current) => (
        <box flexDirection="column">
          <text>{`🎯 Goal · ${current().status}`}</text>
          <text>{truncate(current().objective ?? "", OBJECTIVE_MAX)}</text>
          <text>{budgetLine(current())}</text>
          <Show when={(current().tasks?.total ?? 0) > 0}>
            <text>{`Tasks ${current().tasks?.done ?? 0}/${current().tasks?.total ?? 0}`}</text>
            <For each={(current().taskItems ?? []).filter((task) => task.status !== "done").slice(0, 4)}>
              {(task) => <text>{`- [${task.status}] ${truncate(task.title, 44)}`}</text>}
            </For>
          </Show>
        </box>
      )}
    </Show>
  );
}

export default {
  id: "opencode-goal.local-tui",
  setup(context: any) {
    let release: (() => void) | undefined;
    try {
      release = context?.ui?.slot?.({
        append: "sidebar.content",
        render: ({ sessionID }: { sessionID: string }) => <GoalSidebar context={context} sessionID={sessionID} />,
      });
    } catch {
      return;
    }
    return () => {
      try {
        release?.();
      } catch {
        // ignore
      }
    };
  },
};
