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

两类数据都由 Session 拥有。默认 Provider 参与删除清理和历史补扫；工具归档还会扫描本模块
Blob namespace，回收写入 payload 后、发布 KV index 前中断的孤立记录。只有同一 Session 图
确认已删除的 owner 才可自动回收，无法确认归属的数据保留。
工具输出 Provider 同时要求 Blob 与可枚举 KV，在写入输出前保存 Session 所有权索引；
没有生成最终 ToolResult 的调用也能被发现并回收。旧版共享 namespace 的纯输出字节没有
所有权索引，不能仅凭文件年龄判断可删除。

## 验证

```bash
npm run typecheck
npm run test:tool-result-archive
```
