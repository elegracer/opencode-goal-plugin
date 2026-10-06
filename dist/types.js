/**
 * Plugin domain types. All records here are plain JSON-serializable objects
 * because they are persisted through the host plugin storage.
 */
export const TERMINAL_STATUSES = new Set(["complete", "cancelled"]);
