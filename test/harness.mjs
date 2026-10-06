/**
 * Minimal fake OpenCode 2 plugin context for integration tests.
 * Mirrors the structural API slice in src/api.ts.
 */

export function createHarness(input = {}) {
  const location = input.location ?? {
    directory: "/work/project",
    project: { id: "proj_1" },
  };
  const options = input.options ?? {};

  const storageMap = new Map();
  const eventQueue = [];
  let eventWaiter = null;
  const hooks = { context: [], prompt: [] };
  const toolAfterHooks = [];
  const commands = new Map();
  const tools = new Map();
  const prompts = [];
  const synthetics = [];
  const generated = [];
  const interrupted = [];
  const removed = [];
  const sessionInfos = new Map(Object.entries(input.sessions ?? {}));
  const transcript = input.transcript ?? [];
  let generateResponse = input.generateResponse ?? { text: "APPROVE\nlooks good" };

  const defaultSession = (sessionID) => ({
    id: sessionID,
    sessionID,
    projectID: location.project.id,
    location: { directory: location.directory, workspaceID: location.workspaceID },
  });

  const ctx = {
    location,
    options,
    app: { version: "2.0.22" },
    storage: {
      async get(key) {
        return storageMap.get(key);
      },
      async set(key, value) {
        storageMap.set(key, JSON.parse(JSON.stringify(value)));
      },
      async remove(key) {
        storageMap.delete(key);
      },
      async scan({ prefix, after, limit = 100 }) {
        const keys = [...storageMap.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = after ? keys.findIndex((key) => key > after) : 0;
        const slice = start < 0 ? [] : keys.slice(start, start + limit);
        const entries = slice.map((key) => ({ key, value: storageMap.get(key) }));
        const last = slice[slice.length - 1];
        const hasMore = last ? keys.some((key) => key > last) : false;
        return hasMore ? { entries, next: last } : { entries };
      },
    },
    session: {
      async get({ sessionID }) {
        return sessionInfos.get(sessionID) ?? defaultSession(sessionID);
      },
      async create(createInput) {
        const id = `child_${sessionInfos.size + 1}`;
        const info = {
          id,
          sessionID: id,
          parentID: createInput.parentID,
          projectID: location.project.id,
          location: { directory: location.directory, workspaceID: location.workspaceID },
        };
        sessionInfos.set(id, info);
        return info;
      },
      async remove({ sessionID }) {
        removed.push(sessionID);
      },
      async prompt(promptInput) {
        prompts.push(promptInput);
        return { id: `msg_${prompts.length}` };
      },
      async synthetic(syntheticInput) {
        synthetics.push(syntheticInput);
        return { id: `smsg_${synthetics.length}` };
      },
      async interrupt({ sessionID }) {
        interrupted.push(sessionID);
      },
      async wait() {
        return undefined;
      },
      async context() {
        return transcript;
      },
      async hook(name, callback) {
        if (name === "context") hooks.context.push(callback);
        else if (name === "prompt") hooks.prompt.push(callback);
        return { dispose() {} };
      },
    },
    tool: {
      async transform(callback) {
        callback({
          add(definition) {
            tools.set(definition.name, definition);
          },
        });
        return { dispose() {} };
      },
      async hook(name, callback) {
        if (name === "execute.after") toolAfterHooks.push(callback);
        return { dispose() {} };
      },
    },
    command: {
      async transform(callback) {
        callback({
          add(definition) {
            commands.set(definition.name, definition);
          },
        });
        return { dispose() {} };
      },
    },
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (eventQueue.length > 0) return { value: eventQueue.shift(), done: false };
                return new Promise((resolve) => {
                  eventWaiter = (event) => resolve({ value: event, done: false });
                });
              },
              async return() {
                return { value: undefined, done: true };
              },
            };
          },
        };
      },
    },
    generate: {
      async text(generateInput) {
        generated.push(generateInput);
        return generateResponse;
      },
    },
  };

  return {
    ctx,
    location,
    hooks,
    tools,
    commands,
    prompts,
    synthetics,
    generated,
    interrupted,
    removed,
    storageMap,
    sessionInfos,
    emitEvent(type, data = {}, extra = {}) {
      const event = { id: `evt_${Math.random().toString(36).slice(2)}`, type, data, ...extra };
      if (eventWaiter) {
        const waiter = eventWaiter;
        eventWaiter = null;
        waiter(event);
      } else {
        eventQueue.push(event);
      }
      return event;
    },
    async firePrompt(event) {
      for (const hook of hooks.prompt) await hook(event);
    },
    async fireToolAfter(event) {
      for (const hook of toolAfterHooks) await hook(event);
    },
    async fireContext(sessionID, system = []) {
      const event = { sessionID, system };
      for (const hook of hooks.context) await hook(event);
      return system;
    },
    async runCommand(text, sessionID = "ses_main") {
      const command = commands.get("goal");
      await command.execute({ sessionID, prompt: { text }, delivery: "steer" });
    },
    async runTool(name, toolInput, sessionID = "ses_main", extra = {}) {
      const tool = tools.get(name);
      return tool.execute(toolInput, { sessionID, agent: "build", ...extra });
    },
    setGenerateResponse(response) {
      generateResponse = response;
    },
    wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
