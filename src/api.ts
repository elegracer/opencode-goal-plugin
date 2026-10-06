/**
 * Structural slice of the OpenCode 2 plugin API used by this plugin.
 *
 * This package intentionally has ZERO runtime dependencies:
 * - `Plugin.define` from `@opencode/plugin` is an identity helper; V2 reads
 *   `id` and `setup` from the default export, so a plain object works.
 * - Therefore we do not import `@opencode/plugin` at runtime. The types below
 *   mirror the `@opencode/plugin@2.0.x` Promise API surface we rely on, which
 *   keeps git/npm installs dependency-free and robust.
 *
 * See docs/RESEARCH-AND-PLAN.md and README.md for the compatibility matrix.
 */

export interface Cleanup {
  (): void | Promise<void>
}

export type JsonObject = Record<string, unknown>

export interface StorageEntry {
  key: string
  value: unknown
}

export interface StorageScanOptions {
  prefix: string
  after?: string
  limit?: number
}

export interface StorageScanResult {
  entries: readonly StorageEntry[]
  next?: string
}

export interface Registration {
  dispose: () => void | Promise<void>
}

export interface EventLike {
  id?: string
  type: string
  data?: JsonObject
  [key: string]: unknown
}

export interface SessionInfo {
  id?: string
  sessionID?: string
  parentID?: string
  projectID?: string
  title?: string
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string; [key: string]: unknown }
  location?: { directory?: string; workspaceID?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface PromptFile {
  uri: string
  name?: string
  description?: string
  [key: string]: unknown
}

export interface PromptAgent {
  name: string
  [key: string]: unknown
}

export interface PromptSkill {
  id: string
  [key: string]: unknown
}

export interface SessionPromptInput {
  sessionID: string
  text: string
  files?: PromptFile[]
  agents?: PromptAgent[]
  skills?: PromptSkill[]
  metadata?: JsonObject
  delivery?: "steer" | "queue"
}

export interface SessionCreateInput {
  parentID?: string
  title?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  location?: { directory: string; workspaceID?: string }
  metadata?: JsonObject
}

export interface ToolCallContext {
  sessionID: string
  agent?: string
  messageID?: string
  id?: string
  signal?: AbortSignal
  progress?: (update: JsonObject) => Promise<void>
}

export interface ToolResult {
  content?: string | ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>
  output?: unknown
  metadata?: JsonObject
}

export interface ToolDefinition {
  name: string
  description: string
  input: JsonObject
  options?: { codemode?: boolean; [key: string]: unknown }
  execute: (input: unknown, context: ToolCallContext) => Promise<ToolResult>
}

export interface CommandInvocation {
  sessionID: string
  prompt: {
    text?: string
    files?: PromptFile[]
    agents?: PromptAgent[]
    skills?: PromptSkill[]
  }
  delivery: "steer" | "queue"
}

export interface CommandDefinition {
  name: string
  description?: string
  execute: (input: CommandInvocation) => Promise<void>
}

export interface PluginContext {
  readonly location: {
    directory: string
    workspaceID?: string
    project: { id: string; directory?: string; canonical?: string }
  }
  readonly options: Record<string, unknown>
  readonly app?: { version?: string; channel?: string }
  readonly storage: {
    get: (key: string) => Promise<unknown | undefined>
    set: (key: string, value: unknown) => Promise<void>
    remove: (key: string) => Promise<void>
    scan: (options: StorageScanOptions) => Promise<StorageScanResult>
  }
  readonly session: {
    get: (input: { sessionID: string }) => Promise<SessionInfo | undefined>
    create: (input: SessionCreateInput) => Promise<SessionInfo | undefined>
    remove: (input: { sessionID: string }) => Promise<unknown>
    prompt: (input: SessionPromptInput) => Promise<unknown>
    synthetic: (input: {
      sessionID: string
      text: string
      description?: string
      metadata?: JsonObject
      delivery?: "steer" | "queue"
      resume?: boolean
    }) => Promise<unknown>
    interrupt: (input: { sessionID: string }) => Promise<unknown>
    wait: (input: { sessionID: string }) => Promise<unknown>
    context: (input: { sessionID: string }) => Promise<ReadonlyArray<unknown>>
    hook: (
      name: string,
      callback: (event: any) => void | Promise<void>,
      options?: { providerID?: string },
    ) => Promise<Registration>
  }
  readonly tool: {
    transform: (
      callback: (editor: { add: (tool: ToolDefinition) => void }) => void,
    ) => Promise<Registration>
    hook: (
      name: "execute.before" | "execute.after",
      callback: (event: any) => void | Promise<void>,
    ) => Promise<Registration>
  }
  readonly command: {
    transform: (
      callback: (editor: { add: (definition: CommandDefinition) => void }) => void,
    ) => Promise<Registration>
  }
  readonly event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<EventLike>
  }
  readonly generate: {
    text: (input: {
      model: { providerID: string; id: string; variant?: string }
      prompt: string
    }) => Promise<{ text?: string }>
  }
}

export interface PluginDefinition {
  id: string
  setup: (ctx: PluginContext) => Promise<Cleanup | void> | Cleanup | void
}
