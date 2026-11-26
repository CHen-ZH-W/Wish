# Memory Providers

`storage.ts` 是父级记忆库的权威 Provider，由选定的 Storage Journal 支撑，持久化候选、文档和审计状态。
Host 的记忆整理流水线会自动把提取到的经验整合为可检索文档，并通过一次带审计的 Journal 提交保存。
根 Agent 的读取、查询和快照操作使用当前工作区文件，因此用户直接编辑的内容立即可见，
并会进入下一次带审计的整合。整理 Provider 维护可恢复的 Markdown 工作区，
使用内部 AgentLoop 更新手册、摘要、来源总结和 Skills。模型写入工具追加记录笔记，供自动整合使用。
人工审核仅作为兼容的 Host API 保留。
Memory 专用的操作系统锁协调流水线归属、队列 CAS 和记忆库的读取、写入、发布。
锁在所属进程退出时释放；其他 Storage 数据域仍遵循各自的并发契约。

`storage.ts` 同时提供普通子 Agent 的只读访问。父端 Consumer
`consumers/subagent-resources.ts` 通过 `wish.memory.library` 交付库 ID、文件目录、Journal 根目录
及可调用的 Memory Skill 范围；不复制记忆内容。清单仍绑定父级所有者和子 Agent 的 Session/Run。
子进程校验身份、资源路径和 manifest digest 后，每次读取同一库的当前文件与 Journal，
使用同一 Memory 文件锁协调读取。它只打开 Memory Journal，不共享 Sessions、作业或其他可写数据根。
当前跨进程共享要求 File Journal Provider；其他 Provider 不声明这项子进程读取能力。

子 Agent 的 Memory Provider 拒绝 propose、decide、changeStatus 和 consolidate，
也不修复或截断父级 Journal。默认子配置不加载笔记写入工具或后台整理。
Memory Skill 的调用范围由父级在委派时确定，授权范围内的正文与资源仍读取最新内容。
子 Agent 未获得的 Skill 不会因为共享库新增文件而自动得到调用权限。

没有 Host 资源的子进程不加载 Memory；错误、损坏或身份不匹配的资源使启动失败，
不会回退为独立可写记忆库。父级停止后，已有子进程仍能读取已授权库的已提交内容；
它不依赖父进程提供 RPC 服务。

子 Agent 的最终结果继续回到父会话，参与父级正常的执行证据提取和整理。
该结果回流由 Subagents/Runtime 负责，Memory 资源适配器只负责委派读取入口。

验证：`node scripts/accept-memory-child-resources.mjs` 与 `node scripts/accept-memory-boot.mjs`
覆盖共享读取、更新可见性、写入拒绝、授权校验和默认接线。
`node scripts/accept-memory-child-real.mjs` 使用真实 tmux 与本机模拟模型，
验证子进程启动后能读到父库的新内容、摘要注入和只读工具范围；不证明外部模型或浏览器行为。
