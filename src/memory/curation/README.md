# Memory Curation

根应用的后台记忆链路由用户活动触发，读取已提交会话，提炼原始记忆，再由内部 Agent
增量维护记忆工作区。后续任务读取摘要、检索正文并引用来源；使用记录影响来源保留。
显式记住、修改和忘记也进入这条链路，不创建待人工采纳的候选。

## 触发与来源

非空人类输入的新 Run admission 后发送非阻塞唤醒，Run 完成后再次唤醒；steer、内部
续跑和 child 不触发。扫描在后续事件循环执行，前台不等待磁盘或模型，后台不要求
前台空闲。打开应用仅恢复持久状态；没有独立周期轮询。

会话提取排除触发会话、仍有活动 Run 的会话、归档／删除会话和时间窗口外的会话。
默认至少闲置 6 小时、最近 10 天有活动。每个来源是完整已提交会话快照，包含其多个
Run；system／developer 消息不进入提炼材料。新消息改变来源摘要，允许重新提炼；
旧快照不会与新版并列作为当前来源。Workflow Adapter 提供终态 Attempt 的独立证据。
来源、运行状态与实际验证结果分别保存，Run completed 不能推出任务成功。

## 提取与增量整理

`ModelMemoryExtractor` 使用 Models 的 measured 请求，返回 `raw_memory`、
`rollout_summary` 和 `rollout_slug`。结果先持久化；空结果表示没有可复用知识，不
反复提取同一快照。旧模型返回的 memories 数组及旧 proposing 状态仍可恢复。

`WorkspaceMemoryConsolidator` 同步当前选中的原始记忆和会话摘要，对比上一次成功
整理的完整文件基线，生成 `phase2_workspace_diff.md`。新增、修改、删除和用户直接
编辑都会进入变化集。首轮创建最小记忆结构；没有输入或文件变化时跳过模型。
来源退出保留范围时，即使没有新会话，也会执行整理和清理。

第二阶段使用独立 Core Runtime／AgentLoop。Agent 可以列出、读取、搜索、创建、编辑
和删除记忆工作区文件，实际修改文件后结束；不要求返回文档变更 JSON。它没有用户
Session，不注册前台触发器，不递归提炼自身执行。工作目录是独立暂存目录，文件 Tools
不能越过该目录或跟随 symlink，没有网络工具。生成 Skill 不执行其中脚本。

工作区产物包括：

- `MEMORY.md`：按项目／任务组织的知识、偏好、流程、失败经验及来源引用。
- `memory_summary.md`：首行为 `v1` 的用户摘要、通用经验和导航索引。
- `raw_memories.md`、`rollout_summaries/`：当前选中的提炼结果与来源摘要。
- `skills/<name>/SKILL.md` 及其脚本、参考、模板等资源：可复用操作流程；后续整理
  可以更新、合并或删除。通过 Memory 的文件读取链路使用，不自动安装到用户 Skills 库。
- `extensions/ad_hoc/notes/`：显式记忆变更的追加笔记。

整理要求依据实际证据合并、纠错、去重，处理来源删除后的失效内容，保留仍有其他
证据支持的部分，最后更新摘要和相关 Skills。模型不得伪造验证或保存秘密。正文语义
由模型判断；文件路径、文档版本、证据身份、完整输出和批次一致性由 Host 检查。

提炼条数、每轮任务数、正文长度、模型请求次数、输出 tokens、执行超时和尝试次数
均无 Memory 自设预算。模型实际上下文和生成能力沿用 Models／Provider 配置。
同一个库串行整理，避免并发覆盖，不截断待处理材料。

## 显式笔记、读取与遗忘

`memory_write` 在用户明确请求记住、修改或忘记时追加笔记。返回 recorded 表示请求
已持久化，不表示整理已经结束；后台自动处理，不需要人工接受。笔记绕过会话闲置
筛选，不再重复走模型提取。重复操作身份返回原回执，不同内容使用同一身份会冲突。
笔记索引保留记录时间，后续更正优先；直接编辑或删除笔记也进入变化集，不在后续轮次复活旧内容。

新 Step 注入已提交的 `memory_summary.md`；模型按摘要 → `MEMORY.md` → 对应会话
摘要／Skill 的顺序按需读取。`memory_list` 列出文件，`memory_search` 检索，
`memory_read` 按路径或旧文档 ID 读取，支持可选分页和版本固定。

前台助手引用 `<wish-memory-citation>` 中准确的 `rollout_summaries/<source-id>.md`
路径后，完成钩子记录该来源的使用次数和最后使用时间。仅注入摘要不计作所有来源被使用。
默认未使用窗口为 30 天；从未引用的来源以来源更新时间计算。显式笔记持续保留。
来源删除、归档、被新版会话快照替代或退出保留集合后，变化集通知整理 Agent 清理依赖。
成功后清除过时原始提取正文，保留去重身份，避免重扫又重新提取同一份过期材料。

## 持久化与恢复

`memory/curation` KV Domain 保存任务、原始提取、使用记录、选择基线和待提交整理计划。
Memory Journal 原子保存当前文件文档与审计；物理 Markdown 工作区是可恢复的文件镜像，
用户编辑作为下一轮整理输入。二者不会各自独立修改当前有效文档。

先持久化完整计划，再提交 Journal，最后发布文件镜像和成功基线。提交成功但完成状态
丢失时，通过原 operation ID 恢复文件发布，不再次调用模型。文件镜像发布中断可以
重放；提交后新出现的用户编辑会被保留，继续作为下一轮变化。目录默认位于 Sessions
数据根的 `memories/<libraryId>`。

提取失败保留 queued，整理失败保留原始记忆，后续唤醒重试；同一次唤醒不循环重试
失败阶段。库版本或模型执行期间的文件变化使旧计划失效，下一次按新状态重新整理。
写入前再次核对来源可用性。关闭／替换停止新工作，取消迟到输出，并等待实际 Provider
请求和来源读取退出后释放租约。旧人工候选保留为历史记录，不参与新自动流程。

## 配置与验证

| 配置 | 默认值 | 环境变量 |
| --- | --- | --- |
| automatic | 根应用开启 | `WISH_MEMORY_AUTO_CURATION` |
| model | 当前默认模型 | `WISH_MEMORY_CURATION_MODEL` |
| consolidationModel | 提炼模型 | `WISH_MEMORY_CONSOLIDATION_MODEL` |
| minIdleMs | 21600000 | `WISH_MEMORY_CURATION_MIN_IDLE_MS` |
| maxAgeMs | 864000000 | `WISH_MEMORY_CURATION_MAX_AGE_MS` |
| maxUnusedDays | 30 | `WISH_MEMORY_MAX_UNUSED_DAYS` |
| directory | 数据根下的 memories/libraryId | `WISH_MEMORY_DIRECTORY` |

`WISH_MEMORY_CURATION_ENABLED=0` 关闭整理能力及依赖它的笔记 Tool。Memory 总开关和
child 隔离优先。旧每轮配额、并发、尝试次数、超时、重试间隔配置不再使用。

运行 `npm run test:memory`。`accept-memory-workspace.mjs` 覆盖 Agent 文件操作、Skills、
摘要读取、无新来源的遗忘、显式笔记、使用窗口和发布恢复；Provider 验收通过真实
Application Run 触发完整链路。确定性模型验收不代表外部模型的记忆质量。
当前存储仍全量读取；默认 File Backend 只支持单写 Host，不支持多个进程共享写入根。
