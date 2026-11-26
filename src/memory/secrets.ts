/** Best-effort patterns from Codex 1b53f6a44e, codex-secrets/sanitizer.rs (Apache-2.0). */
export function redactMemorySecrets(value: string): string {
  return value
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/giu, "Bearer [REDACTED_SECRET]")
    .replace(/sk-[A-Za-z0-9]{20,}/gu, "[REDACTED_SECRET]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_SECRET]")
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*["']?\s*[:=]\s*)(["']?)(?!\[REDACTED_SECRET\])[^\s"',}{]{8,}/giu, "$1$2$3[REDACTED_SECRET]");
}
