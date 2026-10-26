import type { ToolInputParseResult } from "../../core/tools/tool.js";

export const bindingSchema = Object.freeze({ executionEpoch: { type: "integer", minimum: 1 }, confirmationDigest: { type: "string", pattern: "^[a-f0-9]{64}$" } });
export function parseBinding(input: Readonly<Record<string, unknown>>): void { positive(input.executionEpoch, "executionEpoch"); if (typeof input.confirmationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.confirmationDigest)) throw new Error("confirmationDigest must be the exact Host SHA-256 digest"); }
export function keys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void { if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unknown Wish Tool input field"); }
export function positive(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`); }
export function text(value: unknown, label: string, max = 4000): void { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text up to ${max} characters`); }
export function strings(value: unknown, label: string): void { if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array up to 100 entries`); for (const item of value) text(item, label); }
export function parseInput<T>(parse: () => T): ToolInputParseResult<T> { try { return { ok: true, input: parse() }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; } }
export function schema(properties: Record<string, unknown>, required: readonly string[]): string { return JSON.stringify({ type: "object", properties, required, additionalProperties: false }); }
