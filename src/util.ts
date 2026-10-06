/** Small dependency-free utilities. No Node-specific APIs: the plugin runs in the host runtime. */

export const nowIso = (): string => new Date().toISOString();

export function makeID(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** FNV-1a 32-bit hash, used to keep storage keys short and filesystem-safe. */
export function hashKey(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Parse "100k" / "1.5m" / "250000" into a number. Returns undefined when unparsable. */
export function parseAmount(input: string): number | undefined {
  const text = input.trim().toLowerCase();
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const suffix = match[2];
  if (suffix === "k") return Math.round(value * 1_000);
  if (suffix === "m") return Math.round(value * 1_000_000);
  return Math.round(value);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return `${Math.round(count)}`;
}

export function formatClock(iso: string | undefined): string {
  if (!iso) return "?";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "?";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clampText(text: string, max: number): string {
  return truncate(text, max);
}
