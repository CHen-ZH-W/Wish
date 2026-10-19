# 插件准入与架构约束

准入分为两个阶段：通过接口、架构、权限声明和隔离生命周期验证，才能取得候选快照；完成配对评测、满足质量预算，并由操作者批准固定 Review 后，才能进入可信主进程。此模块定义规则；[Candidates](../candidates/README.md)持有证据与审批，[Root 管理控制面](../boot/plugin-control/README.md)执行 Step 屏障、Owner 排空、状态事务及恢复。

## 接口与依赖

Manifest 的可选 `contracts` 声明服务协议；包版本、私有状态版本与服务协议版本彼此独立：

```json
{
  "requires": {"compaction": {"version": 1, "methods": ["registerStrategy"]}},
  "provides": {"candidateStats": {"version": 1, "methods": ["read"]}}
}
```

`version` 是正整数协议编号，要求精确匹配；Provider 的方法集合须覆盖 Consumer。`requires` 可声明 `optional: true`，但已绑定的可选 Provider 仍必须兼容。`methods: []` 仅声明数据服务的存在与所有权，不检查数据结构。方法检查核验可调用性，参数、返回值和行为仍由类型检查与契约测试负责。

部署预检检查声明图中的缺失 Provider、唯一 Provider 的版本／方法兼容及依赖循环。已登记的一方 Host 服务可使用 `HOST_SERVICE_CONTRACTS` 的公共协议。多个同名 Provider 的选择交给 Cordis；激活后按 **Consumer Fiber 实际捕获的绑定**核验，不能借用其他 Scope 的同名服务。自定义 Provider 必须声明协议，不能伪装成 Host 内建实现。

声明的 `requires` 必须列入实际 `inject`；候选的实际 `inject` 也必须全部声明。`provides` 必须由该 Fiber 真实提供，不能继承别人提供的同名服务冒充实现。Root 启动、管理配置替换、受控代码 HMR 都核验携带契约的插件；配置替换失败走已有补偿。原生 HMR 无法确认恢复时保留 `recovery-required` 和执行屏障。

现有未携带 `contracts` 的可信部署保留原兼容行为；候选启用严格检查。不能将此兼容路径描述为所有历史插件都已获得接口认证。

## 可执行架构边界

`architecture.ts` 用 TypeScript AST 检查候选入口及其相对模块的传递运行依赖，记录类型导入、运行导入与源码摘要。运行代码当前只开放：

- `wish/plugins/work-owner` 的 `PluginWorkOwner`。
- `wish/plugins/state` 的 `PluginStateError` 与版本化状态句柄入口。
- `wish/compaction/service` 的 `createCompactionResources`。
- `wish/tools/managed` 的 `ManagedToolOwner`。
- Cordis 的 `Service`、Schemastery，以及 path/url/util/crypto/buffer/events 这组 Node 模块。公共类型可用 `import type`。

禁止直接运行导入 Agent Loop、Runtime、装配层和管理控制面，禁止绝对路径、任意第三方包、动态求值、原始文件／网络／进程 API、Host Root 控制和全局监听。工具与策略通过声明的服务接入；作用域注册须传当前 Context。定时任务须声明 Timer 依赖并使用 Cordis 的资源回收机制；异步工作通过 `PluginWorkOwner` 排空。版本化私有状态允许直接调用 `ctx.root.get("pluginState")!.open(ctx, …)`，不开放 Registry 管理接口。

测试代码可使用 Node API 验证算法和真实沙箱拒绝行为；如果运行入口导入该测试或辅助文件，则该文件同样受运行边界约束。构建后 Host 根据源码报告重新检查编译产物的外部导入和 Manifest，不接受 Worker 自报的导入清单作为准入依据。

仓库验收另外扫描完整 `src/core`，阻止稳定核心依赖 Apps、装配层或插件控制面；现有 durability journal 适配器到 `work-owner` 是明确列出的单点例外。Compaction Providers 的运行依赖闭包不得触及 Agent Loop、Runtime 或 Host 内部；公共 Compaction facade 和 WorkOwner 为终止边界。扫描含语料数量下限，避免空目录或收窄输入后假通过。

静态规则约束可维护的插件写法，不能证明任意混淆 JavaScript 无法绕过。未知代码始终在 Linux 子进程沙箱中构建、测试和运行；晋升后的 `trusted-in-process` 是操作者明确授予的信任。

## 运行约束与质量门禁

候选使用的 Manifest 在真实 Loader 激活前注入 Host 分类视图，使 `ManagedToolOwner` 的能力声明检查和私有状态契约在沙箱中也生效。候选 Profile 的能力不能扩大 baseline 的显式上限；Manifest 声明不能超出所选 Agent 的能力。声明不授予权限，实际工具执行仍经过 Permissions、审批和运行沙箱。

Owner 的 pause/drain/dispose、Scope 注册回收、验证／案例超时和进程组清理由现有运行机制负责。Registry 可见性隔离不等于文件、Shell 或网络权限隔离。插件代码应通过受控服务使用这些能力，不能以原始 Node API 绕过。

评审要求完整 baseline/candidate 配对、相同数据集与重复次数、完整请求账本、成功率及回归阈值。`gate` 可进一步记录以下显式预算：

| 字段 | 判定 |
| --- | --- |
| `maximumMeanLatencyMs` / `maximumLatencyRatio` | 候选平均端到端耗时上限／相对 baseline 比例 |
| `maximumTotalTokens` / `maximumTokenRatio` | 全部实验案例输入加输出 Token 总量／比例 |
| `maximumAttempts` | 候选模型请求次数上限 |
| `maximumCostByCurrency` | 各货币的成本上限，例如 `{"USD": 0.25}` |

未设置的性能预算不参与判定。明确要求的 Token 或成本未知时拒绝评审；出现未预算的货币也拒绝。质量不达标报 `candidate_quality_gate_failed`，超预算报 `candidate_performance_gate_failed`，指标缺失报 `candidate_metrics_incomplete`。延迟包含子进程、隔离和 IPC；当前 baseline 与候选执行环境不同，这些预算是操作性限制，不能当作纯算法性能对照结论。

## 证据身份与兼容

Host 生成 `admission.json`，绑定策略版本、源码 digest、Manifest、目标 Entry、baseline 快照、候选 Profile 和架构报告。它与编译文件、依赖锁及发行代码身份一起进入内容寻址产物；Validation 和 Review 记录 `admissionDigest`。执行、评测和批准前都重新核验当前准入结果及归档证据，普通 Experiment 入口也不能绕过。

源码已有 provenance／版本，实际通过的测试数量及生命周期结果保存在 Validation，失败保留诊断，评测事实保存在 Experiments；Review 固定验证结果、上述身份及部署 revision。修改代码、依赖、产物、配置或证据须重新验证／评审。旧验证记录缺少准入证据时不能继续执行或晋升，历史查询和已提交部署的回滚仍可使用原恢复协议。

验收：`npm run test:admission:built`（先构建）、`npm run test:candidates`、`npm run typecheck` 与完整 `npm test`。类型检查、静态边界、真实沙箱、Root 事务和完整回归分别提供证据，不能替代真实模型或已部署实例的验证。
