import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
} from "../dist/tools/presentation/truncate.js";

test("publishes the shared output limits", () => {
  assert.equal(DEFAULT_MAX_LINES, 2000);
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024);
  assert.equal(GREP_MAX_LINE_LENGTH, 500);
  assert.equal(formatSize(DEFAULT_MAX_BYTES), "50.0KB");
});

test("head truncation keeps complete lines and reports the limiting dimension", () => {
  const byLines = truncateHead("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
  assert.deepEqual(byLines, {
    content: "one\ntwo",
    truncated: true,
    truncatedBy: "lines",
    totalLines: 3,
    totalBytes: 13,
    outputLines: 2,
    outputBytes: 7,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 2,
    maxBytes: 100,
  });

  const byBytes = truncateHead("éé\nok", { maxLines: 10, maxBytes: 5 });
  assert.equal(byBytes.content, "éé");
  assert.equal(byBytes.truncatedBy, "bytes");
  assert.equal(byBytes.outputBytes, 4);

  const oversizedFirstLine = truncateHead("🙂🙂\nok", { maxBytes: 7 });
  assert.equal(oversizedFirstLine.content, "");
  assert.equal(oversizedFirstLine.firstLineExceedsLimit, true);

  const emptyFirstLine = truncateHead("\nsecond", { maxLines: 1 });
  assert.equal(emptyFirstLine.content, "");
  assert.equal(emptyFirstLine.outputLines, 1);
});

test("tail truncation keeps final lines and never splits UTF-8", () => {
  const byLines = truncateTail("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
  assert.equal(byLines.content, "two\nthree");
  assert.equal(byLines.truncatedBy, "lines");
  assert.equal(byLines.outputLines, 2);

  const partial = truncateTail("A🙂B", { maxLines: 10, maxBytes: 5 });
  assert.equal(partial.content, "🙂B");
  assert.equal(partial.outputBytes, 5);
  assert.equal(partial.lastLinePartial, true);
  assert.equal(partial.content.includes("�"), false);

  const cannotFitOneCharacter = truncateTail("🙂", { maxBytes: 3 });
  assert.equal(cannotFitOneCharacter.content, "");
  assert.equal(cannotFitOneCharacter.outputLines, 1);
  assert.equal(cannotFitOneCharacter.outputBytes, 0);
  assert.equal(cannotFitOneCharacter.content.includes("�"), false);
});

test("line truncation includes its notice within a Unicode-safe character limit", () => {
  const exact = "🙂".repeat(GREP_MAX_LINE_LENGTH);
  assert.deepEqual(truncateLine(exact), { text: exact, wasTruncated: false });

  const truncated = truncateLine(`${exact}extra`);
  assert.equal(truncated.wasTruncated, true);
  assert.equal([...truncated.text].length, GREP_MAX_LINE_LENGTH);
  assert.equal(truncated.text.endsWith("... [truncated]"), true);
  assert.equal(truncated.text.includes("�"), false);
});
