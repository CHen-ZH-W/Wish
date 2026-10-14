import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../dist/apps/webui/client/ui/markdown.js";

const render = source => renderToStaticMarkup(createElement("div", { className: "message-text message-markdown" }, createElement(MarkdownContent, { source })));

test("assistant Markdown renders common model response structure without accepting raw HTML", () => {
  const html = render(`# 标题\n\n正文有 **粗体**、*强调*、~~删除~~ 和 \`inline()\`。\n\n> 引用 **内容**\n\n1. 第一项\n2. 第二项\n   - 嵌套项\n\n- [x] 已完成\n- [ ] 未完成\n\n| 名称 | 状态 |\n| :--- | ---: |\n| Wish | ok |\n\n\`\`\`ts\nconst ready = true;\n\`\`\`\n\n[官网](https://example.com) <script>alert(1)</script>`);
  assert.match(html, /<h1>标题<\/h1>/u);
  assert.match(html, /<strong>粗体<\/strong>/u); assert.match(html, /<em>强调<\/em>/u); assert.match(html, /<del>删除<\/del>/u);
  assert.match(html, /<blockquote>/u); assert.match(html, /<ol>/u); assert.match(html, /<ul>/u); assert.match(html, /<input[^>]*type="checkbox"[^>]*checked=""/u);
  assert.match(html, /<table>/u); assert.match(html, /text-align:left/u); assert.match(html, /text-align:right/u);
  assert.match(html, /message-code-block/u); assert.match(html, />ts<\/span>/u); assert.match(html, /const ready = true;/u);
  assert.match(html, /href="https:\/\/example.com"/u); assert.match(html, /target="_blank"/u);
  assert.doesNotMatch(html, /<script>/u); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});

test("a paragraph after a loose list remains outside the last list item", () => {
  const html = render(`- 列表项\n\n后续正文`);
  assert.match(html, /<ul><li><p>列表项<\/p><\/li><\/ul><p>后续正文<\/p>/u);
});

test("unsafe links stay inert and streaming fences remain readable", () => {
  const html = render(`[危险](javascript:alert(1)) [锚点](#result)\n\n\`\`\`bash\nprintf 'still streaming'`);
  assert.doesNotMatch(html, /javascript:/u); assert.match(html, />危险<\/span>/u); assert.match(html, /href="#result"/u);
  assert.match(html, /<code>printf &#x27;still streaming&#x27;<\/code>/u);
});
