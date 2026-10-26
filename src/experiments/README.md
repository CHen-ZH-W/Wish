# Experiments

Experiments 负责不可变数据集、实验计划、逐案例事实和结果汇总。Agent Profiles 提供确定的执行快照；process Provider 在独立 Node 进程中启动真实 Wish Loader、Application、Session 和 Runtime，不复制一套 Agent Loop。

## 数据集与计划

```json
{
  "schemaVersion": 1,
  "id": "coding-smoke",
  "version": 1,
  "cases": [{
    "id": "hello",
    "prompt": "将 answer.txt 修改为 hello，末尾保留换行。",
    "files": {"answer.txt": "TODO\n"},
    "assertion": {"kind": "file-equals", "path": "answer.txt", "expected": "hello\n"}
  }]
}
```

断言支持最后一条助手回复的 `exact`、`contains`，或工作区文件的 `file-equals`。文件必须使用相对路径；拒绝穿越目录、`.git` 和断言时逃逸到外部的符号链接。同一 `id@version` 的内容不可变，注册结果返回内容 digest。

```sh
wish experiment dataset dataset.json
wish experiment datasets
```

```json
{
  "datasetDigest": "<dataset-sha256>",
  "variants": [
    {"label": "baseline", "snapshotDigest": "<profile-a-sha256>"},
    {"label": "candidate", "snapshotDigest": "<profile-b-sha256>"}
  ],
  "baseline": "baseline",
  "repetitions": 2,
  "timeoutMs": 120000,
  "maxSteps": 30
}
```

```sh
wish experiment run plan.json
wish experiment list
wish experiment show <experiment-id>
```

Plan 只接受快照 digest。模型、策略、Prompt 或工具均可以作为变量；若要只对比压缩策略，应让其余成员一致。案例按 repetition/case/variant 顺序运行，每次启动新的进程、Session、种子文件工作区及私有持久化目录。目录默认位于 Wish 数据目录的 experiments 下，可用 `WISH_EXPERIMENTS_DIR` 配置。入口无需 WebUI。

## 生命周期与指标

- 实验记录先于启动案例持久化，每个案例结束后立即保存事实和指标；重启可以检查部分结果。
- Ctrl-C / SIGTERM 调用取消并等待进程组清理；超时先终止、再强制结束。Worker 通过 IPC 感知父进程死亡，避免脱离实验 Host 后继续运行。Owner 卸载同样取消并排空工作。
- 进程死亡后的实验和 Run binding 标记 `interrupted`，不自动重跑。已经产生的外部副作用不因状态恢复而撤销。
- `completed` 表示计划已经执行完；断言失败通过 `passed` 和 `successRate` 表达。基础设施失败为 `failed`，取消为 `cancelled`；案例超时为 `timed-out`。
- 汇总成功率、整次案例延迟、全部模型请求次数、Token 和按币种成本。延迟包含 Worker 启动与清理。模型重试及失败请求纳入统计；Usage 或价格未知时总额为 `null`，不伪造为零。Worker 被强制终止而未返回完整账本时，`attemptsComplete: false`，请求总数同样为 `null`；已写入案例私有目录的账本仍保留。仅在相同 case/repetition 已配对时产生相对 baseline 的成功率与延迟差值；不声称统计显著性。

本地进程 Provider 接受可信的已安装插件，工具沿用权限系统与执行 Sandbox，仅允许 `read-only` / `workspace-write`，防止无界权限实验或无人响应的审批挂起。带候选来源标记的快照强制交给 [Candidate Plugin](../candidates/README.md) 注册的 Linux sandbox executor；该 Provider 不存在时拒绝执行，不会降级到普通子进程。HMR、WebUI 和候选管理入口在 Worker 中禁用，冻结的语义配置保留；标准 Storage、Sessions、tmux 等宿主资源位置重定位到该案例目录。自定义 Provider 若持有外部可变状态，仍需要自己的隔离协议。

Storage 的现有文件 Backend 仅保证进程内写入序列化。同一数据目录保持一个写入 Host，读取 CLI 不会误恢复仍存活的任务。需要多 Host 同时写入时，必须先提供具备相应并发保证的 Storage Provider。

`executeProfileTask` 是共享的隔离 Runtime 调用入口，直接调用不会创建 Experiment、运行效果比较或给出 `passed`。它可供其他 Host 消费者复用。完整资源快照接入私有 Skills/Memory Provider，HOME、TMPDIR、工作区、数据与 tmux 位置分别隔离。可选 `requestBudget` 在 Worker 限制模型请求数和输出上限，使用请求字节作保守的输入预算预留，仍只按真实账本报告 Token。该模式使用已支持的标准协议 Adapter，不隐式切换模型或价格协议；自定义协议需要单独提供适配。
