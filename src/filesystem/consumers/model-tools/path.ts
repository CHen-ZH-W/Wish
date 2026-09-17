import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** Expands model-facing filesystem path syntax without applying an access policy. */
export function expandPath(filePath: string): string {
  const normalized = filePath.replace(UNICODE_SPACES, " ");
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return homedir() + normalized.slice(1);
  return normalized;
}

/** Resolves a path against the execution cwd without restricting its scope. */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** Resolves readable filename variants commonly produced by macOS. */
export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  const nfdVariant = resolved.normalize("NFD");
  const candidates = [
    resolved,
    resolved.replace(/ (AM|PM)\./giu, `${NARROW_NO_BREAK_SPACE}$1.`),
    nfdVariant,
    resolved.replace(/'/gu, "\u2019"),
    nfdVariant.replace(/'/gu, "\u2019"),
  ];

  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return resolved;
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
