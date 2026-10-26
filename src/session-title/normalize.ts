/** Cut only between Unicode code points, preserving valid UTF-8. */
export function truncateUtf8(text: string, maxBytes: number, maxCodePoints = Infinity): string {
  let result = "";
  let bytes = 0;
  let points = 0;
  for (const point of text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "\uFFFD")) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maxBytes || points >= maxCodePoints) break;
    result += point;
    bytes += size;
    points += 1;
  }
  return result.trim();
}

function readable(text: string): string {
  return text.normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

export function normalizeTitleText(text: string, maxBytes = 80): string {
  const cleaned = readable(text)
    .replace(/^```(?:[^\s]+)?\s*|\s*```$/gu, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "").trim();
  return truncateUtf8(cleaned, maxBytes);
}

export function fallbackTitle(text: string, options: { readonly maxCodePoints?: number; readonly maxBytes?: number } = {}): string {
  return truncateUtf8(readable(text), options.maxBytes ?? 120, options.maxCodePoints ?? 60);
}

export function clipSeed(text: string, maxCodePoints = 2000): string {
  return truncateUtf8(readable(text), maxCodePoints * 4, maxCodePoints);
}

export function safeTitleErrorCode(code: string): string {
  return /^[a-z][a-z0-9_.-]{0,79}$/iu.test(code) ? code : "generation_failed";
}
