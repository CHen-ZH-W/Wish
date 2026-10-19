# Candidate Plugins

Candidates 将动态源码接入分成候选生成、隔离验证、实验和受控晋升。它不替代 Cordis Loader、Agent Profiles 或 Root 的 ManagedPluginControl。

## 所有权与生命周期

- `Candidates`：不可变 `id@version` 源码、来源、验证记录、实验关联和晋升回执。Storage namespaces 与 Session、部署偏好及插件私有状态分开。
- `CandidateArtifacts`：内容寻址的源码关联、编译文件、外部导入清单及实际 Wish 代码／依赖锁身份。Host 从受限 Worker 取回有大小限制的文件内容，重新创建自己的文件，不接收 Worker 的符号链接或硬链接。所有执行和晋升都重新检查产物及依赖身份。
- Linux Provider：类型检查、构建、测试、真实 Loader 生命周期验证、捕获实验 Profile、隔离运行 Agent。未知源码不在主进程求值。
- Agent Profiles / Experiments：保存候选快照、同数据集 baseline/candidate 逐案例事实、成功率、延迟、Token 和成本。
- ManagedPluginControl：唯一部署队列、Step 安全屏障、Owner 排空、切换、验证、失败恢复与持久化 pending intent。`management/deployment/overlay.json` 是静态输入，与操作日志分目录监听，不修改原始 cordis.yml；进程重启仍加载已晋升的产物。

源码提交不会执行代码。只有类型检查、限定导入构建、至少一个通过的 `node:test`、真实激活、Owner 生命周期与替换声明及正常卸载全部通过，才产生可评测快照。快照带 `candidate` 来源标记，普通 Application 和可信 process executor 会拒绝执行它；仅候选 sandbox executor 可使用。

候选控制面启用时拒绝对归档目录进行原地代码 HMR；修改必须生成新版本并重新验证、评测和批准。归档校验同样覆盖执行、晋升和回滚，不将被修改的文件继续当成已验证产物。

## 使用

CLI 候选命令启用独立的 managed Host。对同一数据目录保持一个写入进程；连接着该目录的 WebUI Host 不能再由另一个 CLI 同时管理。完整 CLI 工作流先设置 `WISH_MANAGED_CLI=1`，让普通 Run 也装载持久化部署 overlay。数据与产物路径可用 `WISH_DATA_DIR`、`WISH_CANDIDATES_DIR`、`WISH_MANAGEMENT_DATA_DIR` 配置。

```sh
export WISH_MANAGED_CLI=1
wish profile register baseline.json
wish profile capture baseline@1 > baseline-snapshot.json
wish candidate submit source.json
wish candidate validate validation-request.json
wish experiment dataset regression.json
wish candidate evaluate evaluation-request.json
wish candidate review review-request.json > review.json
# 检查 review、源码、测试和逐案例记录后，明确授予主进程信任：
wish candidate promote review.json --approve <review-digest>
wish candidate history
wish candidate rollback <promotion-id> --approve <review-digest>
```

源码包是 JSON 数据：

```json
{
  "schemaVersion": 1,
  "id": "selective-compaction",
  "version": 1,
  "entry": "index.ts",
  "files": {"index.ts": "…Cordis plugin source…", "index.test.ts": "…node:test source…"},
  "tests": ["index.test.ts"],
  "config": {},
  "provenance": {"author": "coder-agent", "purpose": "验证新的压缩策略"},
  "manifest": {
    "apiVersion": "wish.plugin/v1",
    "id": "selective-compaction",
    "entry": "./plugin.mjs",
    "managementClass": "managed",
    "replacement": "drain",
    "configSchema": {"type": "object", "additionalProperties": false},
    "permissions": {"capabilities": []},
    "sandbox": {"isolation": "trusted-in-process", "filesystem": "none", "process": "none", "network": "none"},
    "state": {"mode": "stateless"},
    "contracts": {
      "requires": {"compaction": {"version": 1, "methods": ["registerStrategy"]}},
      "provides": {}
    }
  }
}
```

`entry` 指源文件；Manifest 的 entry 固定为构建后的 `./plugin.mjs`。运行代码允许相对源文件、已列入准入策略的公共契约与无特权 Node 模块；测试代码可使用 Node API 验证实际隔离。依赖锁定为当前 Wish 发行版本，禁止任意 npm 安装和生命周期脚本。完整的导入、服务接口与资源所有权规则见[插件准入](../plugin-admission/README.md)。首次安装使用独立 entryId；后续同一 entryId 只能替换该候选流水线已管理、同 Manifest id、相同状态模式的产物。有状态插件须真实打开与 Manifest 相符的私有状态句柄。

`validation-request.json`：

```json
{
  "candidateDigest": "<submit 返回值>",
  "baseSnapshotDigest": "<稳定 baseline 快照>",
  "target": {"parentId": "app", "entryId": "selective-compaction"},
  "profile": {
    "schemaVersion": 1,
    "id": "coder-selective",
    "version": 1,
    "model": "deepseek/deepseek-chat",
    "tools": ["read", "write", "edit"],
    "permissionProfile": "workspace-write",
    "memory": "none",
    "compaction": {"strategyId": "selective-v1"}
  }
}
```

`profile` 是完整的 Agent Profile 定义，模型及权限类型须与 baseline 一致；工具和其他实验变量由其显式指定。验证后返回 `validationId`、`artifactDigest` 和 `snapshotDigest`。`evaluation-request.json`：

```json
{
  "validationId": "<验证 id>",
  "datasetDigest": "<回归和 benchmark 数据集 digest>",
  "repetitions": 2,
  "timeoutMs": 120000,
  "maxSteps": 30,
  "gate": {"minimumSuccessRate": 1, "maximumSuccessRateRegression": 0, "maximumTotalTokens": 100000}
}
```

晋升要求完整的配对实验，基础设施没有失败或缺失的请求账本，并满足显式质量阈值及所选性能预算。Validation 保存实际通过的测试数量、接口与生命周期结果；Host 的 `admission.json` 绑定源码、Manifest、Profile、baseline、目标 Entry 与策略版本。`review-request.json` 包含 `validationId`、`evaluationId`、`reviewer`、`reason`。Review 固定准入 digest、验证结果、源码、产物、候选快照、全部实验事实、目标 entry、原 overlay、部署 digest 和管理 revision。任意漂移要求重新验证／评审；`--approve` 必须匹配内容 digest。测试通过不能替代对进入可信主进程代码的审查。

当前 baseline 使用可信 process executor，候选使用 sandbox executor。延迟包括隔离与 IPC 开销，不能把差值直接当作纯策略算法或晋升后运行的性能结论。可显式设置端到端延迟、Token、请求次数和分货币成本预算；未知用量或成本不能通过相应预算。未设置的性能预算不参与判定，字段见[质量门禁](../plugin-admission/README.md#运行约束与质量门禁)。

Agent 可在 `WISH_CANDIDATE_TOOLS=1` 时调用 `candidate_submit`、`candidate_validate`、`candidate_evaluate`；没有可供模型调用的批准、晋升或回滚工具。提交工具把真实 Run id 写入来源。这个机制不自行启动一个生成任务；现有 Agent 负责写出源码包。

运行中的 WebUI Host 注册 `POST /api/management/extensions/candidates/<action>`，沿用管理控制面的 loopback、Origin、`x-wish-management-token` 和 JSON 检查。操作包括 `submit/list/history/validate/evaluate/review/promote/rollback`，以及准备实验的 `profile-register/profile-capture/dataset/experiment`。`promote` 请求为 `{review, approvedReviewDigest}`；`rollback` 为 `{promotionId, approvedReviewDigest}`。获取 token 的入口沿用 `/api/management/bootstrap`。通过这个接口管理当前 Host，无需再启动一个争用数据目录的 CLI。未添加新的 WebUI 页面。

## 隔离与恢复范围

当前 Provider 要求 Linux Landlock ABI ≥ 3 和 seccomp，无法建立边界时失败，没有无隔离降级路径。每次只开放发行版 dist/node_modules、已验证产物和私有案例目录；写入限于私有 scratch；不继承 Host 凭证或环境。网络、本地控制 socket、向 Host 发信号、脱离进程组被禁止。未知代码执行只允许线程，不允许创建子进程，因此候选评测不可使用 Bash/tmux 等派生进程能力。构建阶段只运行可信 TypeScript/esbuild 编译器，允许其自身构建子进程。

候选进程不开放宿主终端设备，也不能解除内核设置的父进程死亡清理，或通过 prlimit64 修改其他进程的资源限制。这些约束仅用于 candidate mode，不改变正常 Shell 的终端能力。

候选模型请求通过继承的 IPC 通道发送到 Host 的固定模型 Port。Provider、模型、输出预算、并发、请求总量和消息大小受 Host 限制；API key 和解析后的凭证请求头留在 Host。案例超时、取消、Owner 释放和正常结束都清理进程组。子进程失去 Host IPC 后退出。隔离减少未知代码的访问范围，不等同于虚拟机级资源隔离；Linux `RLIMIT_NPROC` 仍按 Unix 用户计数。

验证、实验和晋升先写记录再启动操作。进程死亡后未完成记录标为 interrupted，不自动重放。部署 pending 的隔离与显式恢复沿用管理控制面；无法确认恢复时保持 recovery-required。回滚检查当前 overlay 仍对应本次晋升，并校验保留的旧依赖／产物，避免覆盖后续部署。外部文件副作用不随回滚撤销。

若 Root 已提交部署，而候选回执尚未落盘即崩溃，使用 `wish candidate reconcile <promotion-id>`（管理 API 同名 action）读取 Root 回执和完整 overlay，确认 active／rolled-back／rejected；它不会重放切换。Root 尚有 pending 时先通过原管理恢复入口处理；结果有歧义时拒绝自动判断。

在线晋升支持无状态插件和接入[私有状态协议](../plugin-state/README.md)的版本化插件。迁移先暂存，Root 成功 receipt 持久化后发布；失败保留旧检查点。显式回滚恢复旧产物、配置及其检查点，会回退升级后的私有数据。Benchmark 从独立初始状态运行，不复制生产数据；实际历史数据是否兼容仍由激活时的 validate / migrate 判定。外部可变 Provider、多主机写入、任意第三方依赖安装及候选 UI 代码不在本协议内。已有任务能否继续由 Owner 与 Step 协议决定，不能保证任意插件无中断升级。基础发行代码或依赖变化后，重新构建验证候选，不将历史报告作为新代码的证据。

验收：`npm run test:candidates`。
