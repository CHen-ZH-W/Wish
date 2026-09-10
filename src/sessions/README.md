# Sessions

`src/sessions/` 是 Wish 的会话事实与事务层。它负责保存 Session 身份、规范消息、
全局历史顺序、不透明 revision、幂等追加和 Compaction checkpoint，但不接管 Context
的模型可见历史选择，也不接管 Compaction 的摘要生成。

```text
AgentLoop 组合层 ──提交 User/Assistant/Tool──┐
                                             v
                                      Sessions 事实层
                                      │            │
                         一致历史快照 │            │ CAS checkpoint
                                      v            v
                                   Context     Compaction
```

Context 和 Compaction 必须通过 Sessions adapter 读取同一份事实，不能分别维护两套
历史。Session transcript 也不保存 Context 临时注入的 system/developer 指令。

## 当前进度

Sessions 第一版已经完成：

- Session、Message、Checkpoint、History Snapshot 和 Store Port；
- `create`、`get`、`list`、`updateMetadata`、`archive`、`readHistory`、
  `appendMessages`、`appendCheckpoint` 门面；
- 深复制与冻结、连续 sequence、幂等追加、revision CAS 和 Tool 单元校验；
- Context/Compaction 共用的 history adapter；
- AgentLoop input renderer 和 transcript pipeline adapter；
- 与文件系统分离的内存 Store 和文件 Store；
- 类型测试、事务验收和完整 Context/Compaction/AgentLoop 组合验收；
- G6.1 Cordis `sessions` service、Loader 配置、依赖生命周期和跨 generation 持久化。

当前目录：

```text
src/sessions/
├── README.md
├── index.ts
├── types.ts
├── session.ts
├── transcript.ts
├── memory-store.ts
├── service.ts              # Cordis wrapper；领域实现仍保持框架无关
└── adapters/
    ├── history.ts
    └── agent-loop.ts

src/storage/sessions/
└── file-session-store.ts
```

文件系统逻辑只存在于 `src/storage/sessions/`，不会混入 Sessions 领域模块。

## G6.1：Cordis Service

`Sessions` 是领域层外面的生命周期和装配 wrapper。它提供默认 `dataDirectory`，构造
`FileSessionStore`、`SessionManager` 和唯一的 `SessionHistoryAdapter`，并作为
`ctx.sessions` 暴露。`SessionManager`、Store Port、ContextHistorySource 与
CompactionSessionPort 没有继承或导入 Cordis。

`open(dataDirectory)` 支持 CLI 已解析的显式目录覆盖，并在同一 service generation 内按
规范化目录复用 Session graph。默认目录来自插件 Config；相对路径按 `launch.cwd` 解析，
未配置时使用 `<launch.homeDirectory>/.wish`。service reload 后会创建新的 manager，但
FileSessionStore 会从同一目录读取既有 Session 事实。

当前 File Store 仍是 Sessions service 内部的具体实现，不提前增加 `sessionStore` provider。
只有以后确实需要在配置中动态选择 file/sqlite/postgres/memory/remote 时，才把 Store Port
提升成另一条 Cordis provider/consumer 依赖。

## Session 与历史事实

一个 Session 可以跨越多个 Run；同一个 Run 也可以通过 follow-up 包含多个
UserTurn：

```text
Session
  ├── Run 1
  │   ├── UserTurn 1
  │   └── UserTurn 2
  └── Run 2
      └── UserTurn 1
```

因此 `sessionId` 不等于 `runId`。组合根可以让 `RunInput.scope` 与 `sessionId`
一一对应，利用 Runtime 的 scope 约束避免两个主 Run 同时占用一个 Session；
Sessions 自己不负责调度。

`Session` 保存：

- `sessionId`、`agentId` 和 `scope`；
- `active | archived` 状态；
- `createdAt`、`updatedAt`；
- 只随 transcript 变化的 `historyRevision`；
- 可选的最终展示标题 `title`。

标题生成、失败重试和 UI 展示不属于 Sessions。`updateMetadata` 只提交调用方已经决定
的最终值，而且不会改变 `historyRevision`，因此普通标题修改不会制造无意义的
Compaction CAS 冲突。

历史包含两类 append-only 事实。

### Message Record

`SessionMessageRecord` 保存：

- `recordId`、Session 分配的连续 `sequence` 和调用方提供的 `idempotencyKey`；
- `runId`、`userTurnId`、`stepId`；
- `user_input | steering | assistant | tool | imported` 来源；
- 完整的 provider-neutral `ModelMessage`；
- 可选的 Tool Result archive receipt。

`contentParts`、`reasoningContent`、`toolCalls` 和 `toolCallId` 都会无损保留。Tool
Result receipt 使用 `schemaVersion + toolCallId + locator + hash`，作为 record 的结构
元数据保存，不会混入 `ModelMessage.content`。

### Checkpoint Record

`SessionCheckpointRecord` 保存：

- checkpoint 自己的 `recordId`、`sequence` 和 `idempotencyKey`；
- `coveredThroughSequence` 与实际参与摘要的 `sourceSequences`；
- 压缩原因和一条 `assistant` summary message；
- 可选 provenance 与 summary usage。

Sessions 只保存 Compaction 请求提交的 checkpoint，不选择 `oldEntries`、不生成摘要，
也不汇总或展示费用。

### History Snapshot

`SessionHistorySnapshot` 只暴露：

- `sessionId`；
- 不透明的 `historyRevision`；
- 按 `sequence` 排列的规范 records。

调用方不能假设 revision 等于文件行号、记录数量或某个可自行递增的整数。所有返回对象
都是深复制后的不可变快照。

## Transcript 事务不变量

每次写入都会先复制并冻结调用方数据，再进入 Store 的单 Session 串行事务。

### Message append

- 每次 append 必须包含非空 `idempotencyKey`。
- 相同键和相同内容返回原有提交，不产生重复记录。
- 相同键但内容不同会以 `session_idempotency_conflict` fail closed。
- 一个 batch 中只有部分键已经存在时也会失败，不会把部分重放误当成完整事务。
- 新记录由 Session 分配单调、连续的 history sequence。
- 不保存 system/developer 消息，避免把 Context 注入误记为会话事实。
- `user_input` 和 `steering` 必须是 user 消息；`assistant`、`tool` 来源必须与对应
  消息角色一致。

带 Tool Calls 的 Assistant 消息和全部匹配 Tool Results 必须在一个 batch 中提交：

```text
assistant(toolCalls=[a, b])
  ├── tool(toolCallId=a)
  └── tool(toolCallId=b)
```

同一 Assistant 内重复 Tool Call ID、孤立 Tool Result、错配结果、缺少结果或
Run/UserTurn/Step provenance 不一致都会在写入前失败，整个 batch 不会部分提交。

持久历史仍可能包含旧实现或进程中断留下的不完整 Tool 单元。Sessions 读取时不会静默
删除、补写或篡改这些事实；模型可见副本的确定性修复继续由 Context 负责。

### Checkpoint append

checkpoint 写入必须携带规划时读取的 `expectedRevision`：

1. Store 在单 Session 锁内重新读取当前 revision。
2. 如果相同 checkpoint 已经成功提交，先按幂等身份返回原记录。
3. 否则 revision 不一致时返回 `session_revision_conflict`。
4. coverage 必须指向真实存在的 message sequence。
5. coverage 不能倒退，也不能切开 Assistant/Tool 单元。
6. `sourceSequences` 必须真实存在、严格递增并位于 coverage 范围内。

这样即使写入已经落盘、调用方却在收到回执前中止，使用同一 checkpoint 重试也不会
重复追加；并发新增消息同样不会被过期摘要覆盖。

## Context 与 Compaction adapter

`SessionHistoryAdapter` 基于同一个 `SessionManager` 暴露两个窄视图：

- `context` 满足 `ContextHistorySource`，返回规范化 history records；
- `compaction` 满足 `CompactionSessionPort`，同时返回 records 和
  `historyRevision`，并接受 CAS checkpoint append。

之所以使用两个命名视图，是因为当前两个 Port 都把不兼容的读取操作命名为 `read`：
Context 只需要 record 数组，Compaction 还需要 revision。它们仍由同一个 adapter 和
同一个 Store 提供事实，不是两份历史实现。

映射到 Context 时：

- Message 转为 `kind=message`；
- Checkpoint 转为 `kind=summary`；
- 保留 `sequence`、`userTurnId` 和 Tool Result archive receipt；
- 删除 record ID、时间、origin、revision、Session 管理和 UI 字段；
- 返回按 sequence 排列的不可变快照。

Compaction view 根据规划 revision、coverage、source sequences 和完整 checkpoint
内容生成稳定的 SHA-256 幂等身份。Store 在事务内分配 checkpoint sequence，不允许
Compaction 预先猜测。

## AgentLoop 组合

Sessions 在 AgentLoop 两侧提供两个明确接缝。

### Session-aware Input Renderer

`createSessionInputRenderer()` 装饰现有 `AgentLoopInputRenderer`：

- delegate 生成最终 User Message 后，先原样提交 Session；
- 初始输入使用 `runId/userTurnId/input` 作为幂等身份；
- steering 直接使用 Runtime `controlId`；
- Session 提交发生在 Context 投影和 Model 调用之前；
- Compaction 重投影再次调用 renderer 时只会命中幂等重放；
- 返回 AgentLoop 的消息就是 Store 已提交的同一条规范消息。

### Session Transcript Pipeline

`SessionTranscriptPipeline` 是包含 Compaction 恢复链的最外层 Step pipeline：

```text
SessionTranscriptPipeline
  └── ContextOverflowRecoveryPipeline
      └── AgentLoop
```

它只比较输入和输出 `AgentLoopMemory`，提交本 Step 新增的 Assistant/Tool suffix：

- `continue` 提交 Assistant Tool Call 和全部 Tool Results；
- `completed` 提交最终 Assistant 消息；
- renderer 已经提交的当前用户与 steering 不会重复提交；
- Session commit 成功后才把 Step 结果交回 Runtime；
- commit 失败返回明确的 `session_commit_failed`。

input renderer 和 transcript pipeline 默认都从 `StepSnapshot.run.scope` 解析
`sessionId`。组合根还必须让 `ContextBundle.forStep`、Tool Result archive renderer
和 Compaction target resolver 使用同一个值。完整组合验收覆盖了这条 scope-based
路径。

## 文件存储

`FileSessionStore` 在调用方配置的根目录下使用以下布局：

```text
sessions/
└── session-<sha256(sessionId)>/
    ├── session.json
    └── history.jsonl
```

原始 Session ID 不会直接成为路径。`session.json` 通过同目录临时文件、文件 fsync、
原子 rename 和目录 fsync 更新。Session 创建先准备完整临时目录，再通过 rename 发布，
并刷新父目录。

`history.jsonl` 的每一行是一整个 history transaction，而不是一条独立消息。因此一个
Assistant/Tool batch 不会变成多条分别可见的文件追加。每个事务记录：

- 前一 revision；
- 提交后的 revision；
- commit 时间；
- 本事务的全部 records。

append 会先刷新 history，再原子更新 `session.json`。如果进程在两步之间中断，
JSONL revision 链是权威事实；后续读取会修复落后的 `session.json` 并发出 warning。

损坏处理固定为：

- 中间行 JSON 损坏、未知 schema、revision 链断裂、重复或不连续 sequence：
  `session_corruption`，不静默跳过；
- 最后一行无法解析且没有换行：发出 warning，并截断回最后一个完整事务；
- 最后一行 JSON 完整但只缺少换行：保留事务并持久补回分隔符。

同一 Session 的读取与写入通过进程内队列串行化；不同 Session 可以并行。当前没有
跨进程文件锁，因此 `FileSessionStore` 只声明单进程并发安全。

## 明确边界

Sessions 不实现：

- Context history 选择、prompt 顺序和当前用户保护；
- Token 预算、Tool Result 模型可见裁剪；
- `oldEntries` 规划、摘要生成和压缩重试；
- Model/Provider 调用和 Tool 执行；
- Runtime Run/Step/Tool 中断恢复；
- Workflow、Memory、Skill、Slack/WebUI 同步；
- 标题生成模型、usage/cost 展示；
- Runtime stream delta 的长期 Event Store；
- 常规硬删除 API。

Transport adapter 可以把外部事件转换成规范 Session 输入，但 Sessions record 不包含
Slack、WebUI 或其他具体平台字段。

当前 AgentLoop 会在 Assistant Tool Call 获得权威持久化提交之前开始 dispatch Tool。
因此 Sessions 能保证会话历史、Context 和 Compaction 的一致性，但不能据此宣称进程
在 Tool 执行中被杀死后可以安全自动恢复。已经进入 `dispatched` 的 Tool 可能产生
副作用，必须由后续 Runtime durability/reconciliation 处理，不能在 Sessions 中偷偷
重放。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:cordis-sessions
npm run test:sessions
npm test
```

`test:cordis-sessions` 覆盖 service 依赖生命周期、配置更新失败、stable-id 卸载恢复与
跨 generation 文件持久化。`test:sessions` 覆盖 Session 管理、不可变往返、幂等冲突、并发连续 sequence、Tool
原子 batch、checkpoint CAS、Context/Compaction 共用历史、AgentLoop 提交顺序、文件
恢复，以及完整 Sessions → Context → Compaction → AgentLoop 组合链。
