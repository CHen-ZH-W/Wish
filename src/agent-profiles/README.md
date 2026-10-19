# Agent Profile

Agent Profile 是独立的实验配置领域。部署 Profile（`boot/plugin-control/managed-profile.ts`）负责 Loader 插件树及管理变更；这里负责 Agent 方案版本、不可变执行快照和 Run 绑定。模型、工具、权限、Prompt、Memory 和 Compaction 是并列的配置成员。

## 对象及所有权

- Definition：显式 `id@version` 的不可变配方；同版本不同内容拒绝写入。
- Snapshot：配方加上解析后的模型、Prompt sections、权限、策略参数、完整 Loader 配置、Node/平台和代码文件 SHA-256，使用规范 JSON 的 SHA-256 寻址。相同配方在不同部署上可以产生不同快照。
- Run binding：模型请求和工具执行前持久化 `sessionId/runId/snapshotDigest`；完成、失败、中止和进程中断分别记录。Runtime journal 同时保留 Profile 身份元数据。

服务使用独立 Storage namespaces；不混入管理控制面状态、Session 历史或插件私有状态。当前文件 Backend 的写入保证仍为 `process-local`：同一个数据目录只允许一个写入 Host；另一个 CLI 可以读取现有记录。恢复检查进程 incarnation 和本地 Owner lease，不会仅凭不同 Root ID 判定运行已经崩溃。无法确认死亡时保留原状态，不自动重放任务。

`consumers/application.ts` 将快照转换为 Application 的通用 execution-profile 端口，Core Runtime 不依赖 Profile Store。每个 Application 获得子 AgentScope，固定模型配置、工具上限、Prompt 和 Compaction Provider。每个 Step 在既有执行边界中检查代码与注册代际；配置、Provider 或工具贡献变化会拒绝继续，必须显式开启新的快照执行。这里不提供运行中的隐式版本切换。

## 使用

构建后使用 `node dist/apps/cli/main.js`，或安装的 `wish` 命令：

```json
{
  "schemaVersion": 1,
  "id": "coder",
  "version": 1,
  "model": "deepseek/deepseek-chat",
  "tools": ["read", "grep", "write", "edit", "bash"],
  "permissionProfile": "workspace-write",
  "memory": "none",
  "instructions": "完成任务并验证结果。",
  "compaction": {
    "strategyId": "model-summary-v1",
    "keepRecentTokens": 3000,
    "summaryMaxOutputTokens": 1024
  },
  "reservedOutputTokens": 4096,
  "maxParallelCalls": 4
}
```

`model` 必须存在于当前 Models 配置，工具与权限只能收窄父 Agent 上限。`compaction`、`instructions`、`reasoningEffort`、`request` 和预算字段可选；`request` 接受 `temperature` 与 `maxOutputTokens`。`WISH_AGENT_PROFILES_JSON` 可以在启动时注册配方数组。

```sh
wish profile register profile.json
wish profile list
wish profile capture coder@1 > snapshot.json
wish profile inspect <snapshot-digest>
wish run --agent-profile <snapshot-digest> '实现任务'
wish profile bindings
```

`--agent-profile coder@1` 会在当前部署捕获快照；严格复现实验应使用 digest。`WISH_AGENT_PROFILE` 是应用启动时的默认选择。绑定后请求不能覆盖模型、推理档位或权限；全局默认配置变化也不能静默替换本次选择。

## 复现范围

Snapshot 冻结配置和实现身份，不保证外部模型输出、网络或文件系统世界的确定性。代码 manifest 记录当前 dist、挂载模块、最近 package.json、锁文件和本地 Sandbox 程序；执行前校验这些文件。需要保留对应发行产物和依赖安装，代码缺失或改变会明确拒绝执行；本功能不提供旧产物归档或任意依赖树的可搬迁打包。

凭证只保留环境变量引用，不保存凭证值；明文密钥和敏感请求头拒绝捕获。实验重跑需要相应凭证仍可用。

`memory: "none"` 禁用标准 Memory context/prompt 和 `memory_*` 工具；`"isolated"` 只允许在实验的独立 Host 中使用空的私有 Memory。普通共享 Host 不将共享 Memory 冒充 Agent 私有状态。其他有状态插件遵循自身状态协议；Profile 不负责插件状态迁移。

见 [Experiments](../experiments/README.md) 运行相同数据集的 A/B 对比。验收：`npm run test:agent-profiles`。
