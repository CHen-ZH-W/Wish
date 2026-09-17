# Tool Result Archive

Tool Result Archive 是完整工具结果的持久化能力。它在任何模型可见的裁剪或渲染之前保存
`ToolResult`，并返回与具体 Backend 无关的稳定引用。

## 所有权

- `types.ts` 定义框架无关的 Archive Port 和引用。
- `service.ts` 定义 Cordis `toolResultArchive` Service。
- `providers/blob.ts` 使用 Storage Blob 与 KV index 实现默认 Provider。
- `providers/file.ts` 保留旧文件格式的 standalone 兼容实现。
- `artifacts/` 定义完整 Tool 输出字节的窄存储 seam；默认 Blob Provider 返回
  `wish-tool-output:v1:` 引用，不暴露临时文件路径。

该能力归属于 `src/tools/results/`。默认 Provider 单向依赖 Storage Blob/KV；通用
Storage Backend 不认识 Tool Result、Session、Run 或 Step。Context 是 Archive 的消费者，
负责把引用作为结构化 receipt 带入历史，但不拥有 Archive 契约。

新引用使用 `wish-tool-result:v2:` locator，不暴露本地文件路径。Blob Provider 可以通过
显式 `legacyLocatorRoot` 读取旧 `tool-results/*.json` locator；不会自动重写旧数据。

Bash 等流式 Tool 可以在模型可见尾部被截断前，将有界的完整字节交给
`toolOutputArtifacts`。它与完整 `ToolResult` Archive 是两个阶段：前者保存输出载荷，后者
保存包含 artifact 引用的最终结构化结果。

## 验证

```bash
npm run typecheck
npm run test:tool-result-archive
```
