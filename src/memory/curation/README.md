# Memory Curation

本模块只管理记忆候选的形成任务。它不替代 Runtime／Workflow Scheduler，不接受候选，
也不把 Run 完成等同于测试通过。关闭自动整理不影响 Memory 的读取或人工审核。

## 独立接口与装配

- `CurationEvidenceSource.scan(signal)` 补扫已提交事实，返回冻结、有界的证据包。
- `MemoryCandidateExtractor.extract(evidence, signal)` 产生候选正文，不拥有写入或审核权限。
- `MemoryCurationScheduler` 持久化任务、预算、提炼结果及候选提交进度。
- `DomainCurationStore` 使用现有 Storage KV Domain，namespace 为 `memory/curation`，
  key 为 Memory `libraryId`，不修改 `MemoryState`。
- `providers/curation.ts` 提供 `ctx.memoryCuration`；Runtime／Workflow 证据来源分别由
  `consumers/runtime-evidence.ts`、`consumers/workflow-evidence.ts` 注册。Workflow 是可选依赖。

默认提炼器是 `RecapMemoryCandidateExtractor`：保留执行结果和来源的确定性回顾，不调用
LLM，也不宣称完成了语义去重或知识验证。`ModelMemoryCandidateExtractor` 可由 Host 注入
已经配置的 `Model` 和 `ModelRef`，不依赖 AgentLoop，不继承会话系统提示词，不提供 Tools。
模型请求最多包含 24,000 字符证据，输出上限 2,048 tokens／24,000 字符；固定指令要求把
证据视为不可信数据、保留失败与不确定性，模型产生 Tool Call 或不完整终态会失败。

## 配置与手动入口

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `automatic` | `false` | 是否启用周期补扫与一个有界执行批次 |
| `intervalMs` | `5000` | 自动触发间隔；允许 1–3,600,000 ms |
| `maxConcurrent` | `1` | 每个批次最多并发任务数，范围 1–16 |
| `maxAttempts` | `3` | 正常失败重试上限，范围 1–32 |
| `timeoutMs` | `30000` | 单个来源扫描与单任务执行时间预算，最多 300,000 ms |
| `backendId` | 当前 Storage Backend | 绑定独立 KV 租约，退出排空后释放 |

Host 可以显式调用 `scheduler.scan()`、`tick()`、`state()`、`cancel(jobId)`。
`tick()` 只处理当前一个有界批次；不会隐式启动一个 Run 或接管普通 Shell 命令。
重复注册来源 ID 会失败；注销来源会中止并排空正在进行的读取，然后才能释放来源租约。

## 持久状态与恢复

```text
queued → running → proposing → completed
   │         │          │
   └─────────┴──────────┴→ cancelled
             └→ queued（未超重试预算）／failed
```

任务 ID 绑定完整规范证据包。提炼后的全部正文先持久化，再以 `jobId:index` 作为 Memory
操作 ID 提交候选；每次成功提交后记录 candidate ID。因此在 Memory 已写入、任务进度未写入
之间崩溃，恢复使用原有提炼结果和同一幂等操作 ID，不再次调用模型生成不同候选。

初始化将中断的 `running`／`proposing` 任务恢复为可重试队列；无提炼结果且已耗尽预算的任务
转为失败。已有提炼结果的中断任务允许恢复幂等提交，不因此进行新的模型提炼。
关闭 scheduler 会取消活动操作、等待执行退出，未完成任务保留为持久队列；显式取消的任务
保持 `cancelled`，不会自动恢复。超时或卸载后才返回的提炼内容不会写入 Memory。
取消不会回滚已经提交的 pending 候选，也不会替代人工拒绝；已发生的写入以持久审计为准。

Memory 的 `decide()` 才是采纳入口，且仅接受 human actor。Scheduler 只能 `propose()`，
失败／取消／unknown 的证据同样只能产生明确标识的 pending 候选。

## 证据与限制

Session adapter 根据 Lifecycle 的 `run.opened` 和终态事件补扫，读取该 Run 已提交的
Session records；没有终态的 Run 不整理。原始证据 digest 绑定该 Run 的记录，引用包含
`sessionId:runId` 与 `throughSequence`，后续其他 Run 的聊天不会造成重复整理。
证据正文不包含 system／developer 指令；user role 仍保留独立 `inputSource`，旧记录为
unknown，不能重新认定为人类指令。其他 Session 数据根中不可见的 Session 不越权读取。
默认装配只扫描配置中的 Sessions 根；不保证发现其他 Application 自定义 `dataDirectory`
的终态 Run。此类跨根自动恢复需要 Host 提供持久的 Run／存储身份映射，不能靠遍历任意目录。
证据正文超限会显示 `TRUNCATED EVIDENCE` 与原字符数；完整源记录的 digest 不随裁剪改变。

Workflow adapter 根据已提交的终态 Attempt 生成证据，不根据整个 Workflow revision
重复生成旧 Attempt 的候选。完成状态只是执行事实，不证明测试、浏览器或外部 Provider 已验证。

每个库最多保留 1,000 个整理任务，每任务最多 8 个候选，证据正文最多 32,000 字符。
达到保留预算会明确失败，目前没有自动清理、语义合并或任务游标压缩。原始事件采用全量补扫；
记录规模过大时应更换分页来源和存储实现，而不是关闭去重。默认 File Backend 只保证进程内
写入安全，不能让多个进程共享一个整理状态目录进行并发写入。

验证入口：`scripts/accept-memory-evidence.mjs`、`scripts/accept-memory-curation.mjs`。
测试覆盖漏通知补扫、稳定证据指纹、持久任务恢复、提交响应丢失、预算、取消、来源排空及模型
输入边界；不代表真实外部 Provider 或浏览器端到端验收。
