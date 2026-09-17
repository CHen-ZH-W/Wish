/** Shared bounded-output presentation helpers for model-facing Consumers. */
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

export interface TruncationResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly truncatedBy: "lines" | "bytes" | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
  readonly lastLinePartial: boolean;
  readonly firstLineExceedsLimit: boolean;
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface LineTruncationResult {
  readonly text: string;
  readonly wasTruncated: boolean;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Keeps complete lines from the beginning, bounded by lines and UTF-8 bytes. */
export function truncateHead(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return completeResult(content, totalLines, totalBytes, maxLines, maxBytes);
  }

  const firstLine = lines[0] ?? "";
  if (Buffer.byteLength(firstLine, "utf8") > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    output.push(line);
    outputBytes += lineBytes;
  }

  if (output.length >= maxLines && outputBytes <= maxBytes) {
    truncatedBy = "lines";
  }
  return truncatedResult({
    content: output.join("\n"),
    outputLines: output.length,
    truncatedBy,
    totalLines,
    totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  });
}

/** Keeps the end of the output, including a UTF-8-safe partial final line if needed. */
export function truncateTail(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return completeResult(content, totalLines, totalBytes, maxLines, maxBytes);
  }

  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (
    let index = lines.length - 1;
    index >= 0 && output.length < maxLines;
    index -= 1
  ) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (output.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes);
        output.unshift(partial);
        outputBytes = Buffer.byteLength(partial, "utf8");
        lastLinePartial = true;
      }
      break;
    }
    output.unshift(line);
    outputBytes += lineBytes;
  }

  if (output.length >= maxLines && outputBytes <= maxBytes) {
    truncatedBy = "lines";
  }
  return truncatedResult({
    content: output.join("\n"),
    outputLines: output.length,
    truncatedBy,
    totalLines,
    totalBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  });
}

/** Limits one Grep output line without splitting a Unicode code point. */
export function truncateLine(
  line: string,
  maxChars = GREP_MAX_LINE_LENGTH,
): LineTruncationResult {
  const characters = [...line];
  if (characters.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }

  const suffix = [..."... [truncated]"];
  const prefixLength = Math.max(0, maxChars - suffix.length);
  return {
    text: [...characters.slice(0, prefixLength), ...suffix.slice(0, maxChars)].join(""),
    wasTruncated: true,
  };
}

function completeResult(
  content: string,
  totalLines: number,
  totalBytes: number,
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

function truncatedResult(input: {
  readonly content: string;
  readonly outputLines: number;
  readonly truncatedBy: "lines" | "bytes";
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly lastLinePartial: boolean;
  readonly firstLineExceedsLimit: boolean;
  readonly maxLines: number;
  readonly maxBytes: number;
}): TruncationResult {
  return {
    ...input,
    truncated: true,
    outputBytes: Buffer.byteLength(input.content, "utf8"),
  };
}

function truncateStringToBytesFromEnd(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;

  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}
