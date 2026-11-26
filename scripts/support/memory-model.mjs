/** Deterministic provider exercising the actual multi-step consolidation AgentLoop. */
export function* memoryConsolidationEvents(request, options = {}) {
  const toolMessages = request.messages.filter(item => item.role === "tool");
  const call = (id, name, input) => ({ type: "tool_call", call: { id, name, argumentsJson: JSON.stringify(input) } });
  if (!toolMessages.length) {
    yield call("read-raw", "memory_read_file", { path: "raw_memories.md" });
    yield call("read-diff", "memory_read_file", { path: "phase2_workspace_diff.md" });
    yield { type: "done", finishReason: "tool_calls" }; return;
  }
  if (!request.messages.some(item => item.role === "assistant" && item.toolCalls?.some(call => call.name === "memory_write_file"))) {
    const sources = [...new Set(JSON.stringify(toolMessages).match(/curation-[a-f0-9]{64}/gu) ?? [])];
    const references = options.citeSources === false ? "" : sources.map(id => `rollout_summaries/${id}.md`).join("\n");
    const memory = options.memory ?? "修改后先执行项目验收脚本，并记录验证层次。";
    yield call("write-handbook", "memory_write_file", { path: "MEMORY.md", content: `# Project validation\n\n${memory}\n\n${references}` });
    yield call("write-summary", "memory_write_file", { path: "memory_summary.md", content: `v1\n\nProject validation: ${memory}\nSee MEMORY.md.\n${references}` });
    for (const [path, content] of Object.entries(options.files ?? {})) yield call(`write-${path}`, "memory_write_file", { path, content });
    for (const path of options.remove ?? []) yield call(`remove-${path}`, "memory_delete_file", { path });
    yield { type: "done", finishReason: "tool_calls" }; return;
  }
  yield { type: "text_delta", text: "Memory workspace updated." };
  yield { type: "done", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38, source: "provider" } };
}
