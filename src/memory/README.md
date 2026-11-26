# Memory

Memory 为后续任务保存、检索并持续维护跨会话知识。后台学习、显式记忆变更、摘要注入、
按需读取、使用反馈和遗忘形成同一条自动链路。知识包含事实、偏好、失败经验及可复用
Skill 流程；记忆来源与实际验证结果分别保留。

## 自动链路

普通人类 Run 启动及完成后异步唤醒后台任务。第一阶段对闲置会话的完整已提交快照
提取原始记忆和摘要；第二阶段由独立 Agent 读取变化集并维护 `MEMORY.md`、
`memory_summary.md`、`rollout_summaries/` 和 `skills/`。它可以更新、合并和删除
知识，不只是追加新条目。无变化时不调用整理模型。

新 Step 获取记忆摘要，随后按需读取正文和流程。来源引用回流为使用记录；过期、删除
或被替代的来源进入下一轮清理。显式记住／修改／忘记通过追加笔记处理，没有候选审核。
完整触发条件、配置、文件结构及恢复协议见 [curation/README.md](curation/README.md)。

## 模块边界

| 位置 | 职责 |
| --- | --- |
| `types.ts`、`memory.ts`、`validation.ts` | 文档、来源、版本、幂等、自动批次及旧审核 API |
| `store.ts` | Journal 原子提交、审计和恢复回执 |
| `files.ts`、`retrieval.ts`、`citations.ts` | 文件读取视图、逐行子串检索和结构化引用 |
| `service.ts`、`providers/storage.ts` | Cordis 能力定义与持久 Provider |
| `curation/` | 提取、内部 Agent、文件变化、使用记录、保留与恢复 |
| `adapters/` | Session／Workflow 已提交证据 |
| `consumers/context.ts` | 注入当前摘要与渐进读取提示 |
| `consumers/model-tools.ts` | search、list、read 和追加记忆笔记 |
| `consumers/skills.ts` | 将生成的 Skills 接入 Wish 级技能库，并执行用户启停过滤 |
| `consumers/curation-trigger.ts` | 前台触发与来源引用反馈 |
| `child-resources.ts`、`consumers/subagent-resources.ts` | 向子 Agent 委派共享库的只读访问 |

Core、Sessions 和 Tools 不依赖 Memory 领域。Workspace 提供工作区事实；知识中的
适用范围用于相关性判断，不替代访问权限。一个 libraryId 形成共享库，不为每次会话
新建长期知识库。

## 模型入口

- `memory_search`：按字面子串逐行搜索，返回路径、命中行号及上下文。支持 queries、
  路径范围、同一行／行窗口组合、大小写、分隔符归一化和可选分页；不使用文档加权排序。
- `memory_list`：列出记忆文件与 Skills，支持按路径和可选分页读取目录。
- `memory_read`：按路径和 1 起始行号读取正文；sourceId 可回查 Host 已捕获的来源。
  旧文档 ID、字符分页及版本固定仍兼容；expectedDigest 可检测直接文件编辑。
- `memory_write`：用户明确要求记住、修改或忘记时，保存追加笔记并触发自动整理。
  返回 recorded 是持久回执，不能冒充整理完成。

写入证据由 composition 提供的 `sessionHistory.read(signal)` 捕获，绑定当前 Application
实际持有租约的 Session 数据根，不从默认目录猜测同名 Session。模型不能传任意证据
路径。读取使用 runtime.read，笔记写入使用 runtime.control，并绑定准确请求与执行
身份。笔记 Tool 沿用当前 Run 的权限配置；选择 approval-required 时仍受通用工具审批约束。
Plan／Coordinator 注册读取控制；root 的后台整理无需前台工具批准或记忆采纳。

Memory 不设置模型请求、输出 tokens、正文长度或条数预算。模型能力仍受当前 Models
配置及实际上下文窗口约束。检索使用词法匹配，语义归纳与冲突处理交给整理 Agent。

## 存储与兼容

自动整理通过 Host `consolidate()`，将文件文档与审计作为一个批次写入 Journal。
实体文件是 root 的日常读取入口，用户直接编辑立即对后续读取和摘要投影可见，
编辑在下一轮被纳入整理并写入审计；提交计划和成功基线确保崩溃恢复
不会再次调用模型或覆盖提交后的新编辑。历史版本与审计保留；从当前记忆中忘记内容
不代表擦除审计历史或原始 Session。

旧 `propose()/decide()` 和人工 status API 仍用于既有 Host 集成与历史记录，候选管理由
调用这些 API 的 Host 负责。新模型 Tool 和后台整理都不经过它们。

child 不加载后台学习或笔记 Tool，由同一个 Storage Memory Provider 只读访问父级当前记忆库，
能从摘要继续读取正文和授权的 Memory Skills；父级更新在下一次读取可见，不生成记忆副本。
子 Agent 会话和其他运行数据仍使用私有目录，成果通过父会话进入正常记忆学习链路。
读取授权与资源绑定见 [providers/README.md](providers/README.md)。

默认来源扫描覆盖当前 Sessions 数据根。主动笔记使用当前 Session Port；自定义数据根
的跨进程恢复仍需要 Host 的持久身份映射。Memory 使用 OS 文件锁协调流水线、队列和
库读写，进程退出释放锁；这不改变其他领域的 File Backend 单写契约，也不代表整套
Wish 可以共享写入数据根。当前 Journal 和队列仍全量读取。

验证：`npm run test:memory`、`npm run typecheck`。默认验收使用临时数据根与确定性模型，
覆盖实际 Runtime／AgentLoop 和 Application 接线；不代表真实外部模型、浏览器或部署验收。
