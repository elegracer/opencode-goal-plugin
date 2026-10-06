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
import { hashKey, isRecord } from "./util.js";
export const STORAGE_VERSION = "v1";
const VALID_STATUSES = new Set([
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
    storage;
    scope;
    onMutate;
    chains = new Map();
    constructor(storage, scope, onMutate) {
        this.storage = storage;
        this.scope = scope;
        this.onMutate = onMutate;
    }
    scopePrefix() {
        const project = encodeURIComponent(this.scope.projectID);
        const location = hashKey(`${this.scope.directory}\u0000${this.scope.workspaceID ?? ""}`);
        return `goal/${STORAGE_VERSION}/${project}/${location}/`;
    }
    key(sessionID) {
        return `${this.scopePrefix()}${encodeURIComponent(sessionID)}`;
    }
    /** Storage key used for cross-instance claim arbitration. */
    claimKey(sessionID, purpose) {
        return `${this.scopePrefix()}claim/${encodeURIComponent(sessionID)}-${purpose}`;
    }
    /**
     * Location-independent index key per session. Lets a different plugin
     * instance (or an RPC call carrying another location) find a goal's actual
     * storage scope.
     */
    indexKey(sessionID) {
        return `goal/index/${STORAGE_VERSION}/${encodeURIComponent(sessionID)}`;
    }
    /** Write only the location index entry for an existing record. */
    async ensureIndex(goal) {
        await this.storage.set(this.indexKey(goal.sessionID), {
            projectID: goal.projectID,
            directory: goal.locationDirectory,
            workspaceID: goal.workspaceID,
        });
    }
    /** Load a goal from any scope through the session index. */
    async loadByIndex(sessionID) {
        const entry = await this.storage.get(this.indexKey(sessionID));
        if (!isRecord(entry))
            return undefined;
        const projectID = typeof entry.projectID === "string" ? entry.projectID : undefined;
        const directory = typeof entry.directory === "string" ? entry.directory : undefined;
        if (!projectID || !directory)
            return undefined;
        const workspaceID = typeof entry.workspaceID === "string" ? entry.workspaceID : undefined;
        const store = new GoalStore(this.storage, { projectID, directory, workspaceID });
        return store.load(sessionID);
    }
    /**
     * Last-resort lookup: scan every scope for a record with this session ID.
     * Used by RPC when the index is missing (records saved before it existed).
     */
    async findBySession(sessionID) {
        const prefix = `goal/${STORAGE_VERSION}/`;
        let after;
        for (let page = 0; page < 20; page++) {
            const result = await this.storage.scan({ prefix, after, limit: 200 });
            for (const entry of result.entries) {
                if (entry.key.includes("/claim/") || entry.key.startsWith("goal/index/"))
                    continue;
                const record = this.validate(entry.value, sessionID);
                if (record)
                    return record;
            }
            if (!result.next)
                break;
            after = result.next;
        }
        return undefined;
    }
    validate(value, sessionID) {
        if (!isRecord(value))
            return undefined;
        if (value.v !== 1)
            return undefined;
        if (value.sessionID !== sessionID)
            return undefined;
        if (typeof value.goalID !== "string")
            return undefined;
        if (typeof value.status !== "string" || !VALID_STATUSES.has(value.status))
            return undefined;
        const record = value;
        // Normalize fields added after v1 records were first persisted.
        if (!Array.isArray(record.tasks))
            record.tasks = [];
        if (!Array.isArray(record.checkpoints))
            record.checkpoints = [];
        if (!Array.isArray(record.history))
            record.history = [];
        if (!Array.isArray(record.evidence))
            record.evidence = [];
        if (!Array.isArray(record.archive))
            record.archive = [];
        return record;
    }
    async load(sessionID) {
        const value = await this.storage.get(this.key(sessionID));
        return this.validate(value, sessionID);
    }
    async save(goal) {
        await this.storage.set(this.key(goal.sessionID), JSON.parse(JSON.stringify(goal)));
        await this.storage.set(this.indexKey(goal.sessionID), {
            projectID: goal.projectID,
            directory: goal.locationDirectory,
            workspaceID: goal.workspaceID,
        });
    }
    /**
     * Serialized read-modify-write. The mutator may return undefined to remove
     * the document (used by tests / hard resets); normal flows always return the
     * draft.
     */
    mutate(sessionID, mutator) {
        const previous = this.chains.get(sessionID) ?? Promise.resolve();
        const execute = async () => {
            const current = await this.load(sessionID);
            const next = mutator(current);
            if (!next) {
                await this.storage.remove(this.key(sessionID));
                await this.storage.remove(this.indexKey(sessionID));
                this.onMutate?.(sessionID);
                return undefined;
            }
            await this.save(next);
            this.onMutate?.(sessionID);
            return next;
        };
        const run = previous.then(execute, execute);
        this.chains.set(sessionID, run.then(() => undefined, () => undefined));
        return run;
    }
    /** All goal records for this project+location (used by restart recovery). */
    async scan() {
        const prefix = this.scopePrefix();
        const found = [];
        let after;
        for (let page = 0; page < 50; page++) {
            const result = await this.storage.scan({ prefix, after, limit: 100 });
            for (const entry of result.entries) {
                const sessionID = this.sessionFromKey(entry.key);
                if (!sessionID)
                    continue;
                const record = this.validate(entry.value, sessionID);
                if (record)
                    found.push(record);
            }
            if (!result.next)
                break;
            after = result.next;
        }
        return found;
    }
    sessionFromKey(key) {
        const prefix = this.scopePrefix();
        if (!key.startsWith(prefix))
            return undefined;
        const tail = key.slice(prefix.length);
        if (!tail || tail.includes("/"))
            return undefined;
        try {
            return decodeURIComponent(tail);
        }
        catch {
            return undefined;
        }
    }
}
