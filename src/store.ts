/**
 * Durable goal storage on top of the host plugin storage (`ctx.storage`).
 *
 * - One JSON document per session; older goals are archived inside the record.
 * - Read-modify-write is serialized per session within this process.
 * - Keys include project and location so goals never leak across locations.
 *
 * The host storage is last-write-wins without compare-and-set, so this plugin
 * assumes a single OpenCode server process per storage database (documented in
 * README). No cross-process lock files are used on purpose: stale locks are a
 * worse failure mode than the single-writer assumption.
 */

import type { GoalRecord, GoalStatus } from "./types.js";
import { hashKey, isRecord } from "./util.js";

export const STORAGE_VERSION = "v1";

export interface StoreScope {
  projectID: string;
  directory: string;
  workspaceID?: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set<GoalStatus>([
  "active",
  "paused",
  "blocked",
  "complete",
  "cancelled",
  "budget_limited",
  "usage_limited",
  "stalled",
]);

export class GoalStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storage: {
      get: (key: string) => Promise<unknown | undefined>;
      set: (key: string, value: unknown) => Promise<void>;
      remove: (key: string) => Promise<void>;
      scan: (options: { prefix: string; after?: string; limit?: number }) => Promise<{
        entries: readonly { key: string; value: unknown }[];
        next?: string;
      }>;
    },
    private readonly scope: StoreScope,
  ) {}

  private scopePrefix(): string {
    const project = encodeURIComponent(this.scope.projectID);
    const location = hashKey(`${this.scope.directory}\u0000${this.scope.workspaceID ?? ""}`);
    return `goal/${STORAGE_VERSION}/${project}/${location}/`;
  }

  key(sessionID: string): string {
    return `${this.scopePrefix()}${encodeURIComponent(sessionID)}`;
  }

  private validate(value: unknown, sessionID: string): GoalRecord | undefined {
    if (!isRecord(value)) return undefined;
    if (value.v !== 1) return undefined;
    if (value.sessionID !== sessionID) return undefined;
    if (typeof value.goalID !== "string") return undefined;
    if (typeof value.status !== "string" || !VALID_STATUSES.has(value.status)) return undefined;
    return value as unknown as GoalRecord;
  }

  async load(sessionID: string): Promise<GoalRecord | undefined> {
    const value = await this.storage.get(this.key(sessionID));
    return this.validate(value, sessionID);
  }

  async save(goal: GoalRecord): Promise<void> {
    await this.storage.set(this.key(goal.sessionID), JSON.parse(JSON.stringify(goal)));
  }

  /**
   * Serialized read-modify-write. The mutator may return undefined to remove
   * the document (used by tests / hard resets); normal flows always return the
   * draft.
   */
  mutate(
    sessionID: string,
    mutator: (current: GoalRecord | undefined) => GoalRecord | undefined,
  ): Promise<GoalRecord | undefined> {
    const previous = this.chains.get(sessionID) ?? Promise.resolve();
    const run = previous.then(
      async () => {
        const current = await this.load(sessionID);
        const next = mutator(current);
        if (!next) {
          await this.storage.remove(this.key(sessionID));
          return undefined;
        }
        await this.save(next);
        return next;
      },
      async () => {
        const current = await this.load(sessionID);
        const next = mutator(current);
        if (!next) {
          await this.storage.remove(this.key(sessionID));
          return undefined;
        }
        await this.save(next);
        return next;
      },
    );
    this.chains.set(
      sessionID,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** All goal records for this project+location (used by restart recovery). */
  async scan(): Promise<GoalRecord[]> {
    const prefix = this.scopePrefix();
    const found: GoalRecord[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.storage.scan({ prefix, after, limit: 100 });
      for (const entry of result.entries) {
        const sessionID = this.sessionFromKey(entry.key);
        if (!sessionID) continue;
        const record = this.validate(entry.value, sessionID);
        if (record) found.push(record);
      }
      if (!result.next) break;
      after = result.next;
    }
    return found;
  }

  private sessionFromKey(key: string): string | undefined {
    const prefix = this.scopePrefix();
    if (!key.startsWith(prefix)) return undefined;
    const tail = key.slice(prefix.length);
    if (!tail || tail.includes("/")) return undefined;
    try {
      return decodeURIComponent(tail);
    } catch {
      return undefined;
    }
  }
}
