# Memory

Memory 保存可跨会话复用的知识、适用范围、来源及审核状态。它不是完整聊天记录，不拥有
Tasks／Workflow 的执行状态，也不是更高权限的指令来源。Memory 本身不依赖 Tools、
Context、Apps 或 Cordis；这些模块通过独立 Consumer 接入。

## 职责与目录

| 位置 | 职责 |
| --- | --- |
| `types.ts`、`memory.ts`、`validation.ts` | 领域契约、合法状态转换、版本冲突、幂等与审核规则 |
| `retrieval.ts` | 确定性的词法检索，仅返回 accepted 文档 |
| `store.ts` | Memory 持久化契约适配，变更与审计同一次 Journal 提交 |
| `service.ts`、`providers/storage.ts` | Cordis 能力定义和 Storage Provider |
| `consumers/context.ts` | 有界的模型检索索引，非完整正文注入 |
| `consumers/model-tools.ts` | 可选的 search、read 和候选 write 入口 |
| `consumers/mode-controls.ts` | Plan／Coordinator 的只读能力注册 |
| `consumers/session-feature.ts` | 人工审核界面，复用 Apps 通用 SessionFeature |
| `adapters/`、`curation/` | 已提交执行证据、独立整理状态和 Scheduler |
| `child-resources.ts`、`providers/child-snapshot.ts` | 子 Agent 的只读知识快照与候选交换 |

Storage 是基础设施，Memory 拥有文档格式、来源、采纳规则和派生索引。Workspace 只提供
工作区事实；`appliesTo` 用于判断知识是否相关，不能替代访问权限。默认一个 Host 指定的
`libraryId` 形成共享库，不为每个 Session 新建长期记忆库。

## 候选、采纳与修改

所有新增和更新先调用 `propose()`，生成 `pending` 候选。候选包含目标 ID、预期文档版本、
正文、适用范围、关键词、证据、提出者与理由。提交候选不覆盖已采纳文档。

`decide()` 仅允许 human actor，按候选版本执行 accept／reject；采纳时还要检查目标文档
是否仍为提案针对的版本。审核之后候选继续保留，审计不删除。文档可由 human actor 标为
`stale`、`superseded` 或 `deleted`；被替代时必须引用另一份 accepted 文档，删除是保留
历史的逻辑删除，不是物理抹除文件。

每次变更带 Host 提供的 `operationId`。相同 ID、相同请求是幂等重放；同一 ID 用于不同
内容则拒绝。未知写入结果必须使用原操作身份对账，不能重新生成 ID 盲目重试。

证据记录 `kind`、`id`、`revision` 和 SHA-256 digest；Session 证据还可带
`throughSequence`，精确定位当时已提交的记录边界。有来源不等于来源仍然正确；采纳也不
意味着此后永远有效。人类界面通过候选身份、版本和 digest 绑定具体审核对象，不能由模型
输出“用户已同意”绕过审核。

## Context 与可选 Tools

Context Provider 按当前已渲染输入检索，最多贡献 8 项精简索引，并有独立字符上限。
索引含 ID、version、digest、适用范围与短摘要；它以 reference 内容进入模型上下文，
不是 system／developer 指令。只有当前 Step 实际可见 `memory_read` 时才推荐该入口。

- `memory_search`：检索 accepted 文档，返回有界索引。
- `memory_read`：按 ID、预期版本分页读取；版本改变时要求重新检索。
- `memory_write`：只提出 pending 候选，证据由 Host 从已提交 Session 事实获取；
  模型不能传入任意证据路径或伪造读取权限。

主动候选写入使用 composition 提供的 `sessionHistory.read(signal)` 只读 Port，绑定当前
Application 已获得租约的 Session 数据根与 Session ID；不根据默认目录查找相同 ID。
Port 缺失、返回错误 Session 或没有本 Run 已提交记录时拒绝写入。因此自定义
`dataDirectory` 与默认数据根保持隔离，普通 Tool 不能通过此 Port 读取任意 Session。

Tool 的读取使用 `runtime.read` 能力，候选写入使用独立的 `runtime.control` 能力，
并绑定库、输入、Workspace 和执行身份。Plan／Coordinator 只注册 search／read 控制，
模式批准不等于记忆写入或采纳批准。没有 Tool Consumer 时，Host 仍然可以调用 Memory
能力；没有 Context Consumer 时，也不会自动把记忆塞入模型请求。

## 持久化、子 Agent 与整理

Storage Provider 通过独立租约打开 `memory/<libraryId>` Journal，要求原子 batch 和 fsync。
每条提交把领域变更和审计一起落盘，读取重放时验证 revision、文档版本和合法状态转换。
读取关闭后拒绝新请求，已有写入排空后释放 Storage 租约。

默认 File Backend 仅保证进程内写入安全。tmux 子 Agent 不直接共享父端的可写 Journal：
由 Host 选择并固定知识快照，子端使用独立 Provider，回传候选后由父端验证归属、版本与
证据，再提交到父端候选库。子进程不能因此获得人工采纳权限或任意库路径。
具体子端资源契约见 `providers/README.md`。

父端先订阅 `subagent.updated`，再在启动时对已配置数据根中的持久 Run 做一次补扫；
后续完成事件增量触发导入，不周期性重放所有历史 Run。已删除的父 Session 不再作为
可重试错误，也不能接收新的子端候选；若确有已完成的子端结果，会对该子端给出一次
“父会话已删除，未导入”的诊断。子 Session 证据缺失或校验失败仍拒绝导入并报告，
候选留在子端交换文件中供排查。实时事件遇到父 Session 在默认数据根缺失时，先通过
Sessions 的只读墓碑查询排除明确删除；若只是另一个 Application 数据根中的会话，则
继续依赖子端 manifest、Subagent owner 和证据验证，保持该路径的现有行为。

自动整理默认关闭。默认提炼实现是确定性 recap，不调用 LLM；可选模型提炼器只接收有界
不可信执行证据和固定指令，不复用 AgentLoop。整理有自己的持久任务、并发、重试、时间
预算和取消恢复，始终只产生候选，不自动采纳。完整契约见 [curation/README.md](curation/README.md)。

默认 Runtime 证据补扫及子 Agent 恢复扫描只覆盖已配置的 Sessions 数据根，不枚举磁盘上
其他 Application 的自定义目录。主动 `memory_write` 使用当前 Session Port，可以精确
访问其自定义数据根；任意自定义根的跨进程自动恢复需要另行提供持久的 Run／存储身份映射。

## 当前限制与验证

- 检索是词法匹配，不是向量库或语义去重；索引可从权威状态重新构建。
- 一个 Memory state 最多 1,000 文档、5,000 候选、10,000 审计项，超限明确拒绝。
- 正文最多 32,000 字符，每项最多 32 个关键词和 32 条证据；模型入口有额外分页预算。
- 当前没有另一套可独立修改的 Markdown 权威文件库；不能把导出文件与 Journal 同时当主库。
- 自动整理的 Run／Attempt 完成状态不代替测试结果、浏览器检查或外部 Provider 的真实验证。

验证入口包含 `accept-memory.mjs`、`accept-memory-storage.mjs`、`accept-memory-evidence.mjs`、
`accept-memory-curation.mjs`，以及独立的 Context／Tools／子端资源集成测试。
构建和本地 mock 模型测试不代表真实外部 Provider 或多进程并发写存储已经验收。
