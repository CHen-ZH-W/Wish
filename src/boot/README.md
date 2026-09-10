# Boot

`src/boot/` 是 CLI、WebUI 共用的进程启动粘合层，不是业务能力插件目录。它创建 Cordis
Root、加载默认或外部 profile，并把启动事实交给配置树；各插件仍归属于 Apps、Sessions、
Models 等实际能力目录。Cordis 负责插件树、服务依赖、隔离、effect 生命周期和 HMR；
Wish 的 Run、Step、Session、ToolCall 等领域数据与不变量继续由对应模块定义。

当前启动代码只有 `bootstrap.ts` 与 `launch.ts`。默认组合位于 `config/cordis.yml`；正式
Application service、CLI 和 WebUI 插件分别位于 `src/apps/service.ts`、
`src/apps/cli/plugin.ts` 与 `src/apps/webui/plugin.ts`。能力插件都放在它们自己的
模块，不建立统一的 `cordis/plugins` 容器。

## G0：发布包基线

T0 只锁定并验证框架发布面，不改动现有 Apps/Core 组合：

| Package | Version |
| --- | --- |
| `@deepseek-ai/cordis` | `4.0.2` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.3` |
| `@deepseek-ai/cordis-plugin-include` | `1.0.7` |
| `@deepseek-ai/cordis-plugin-group` | `1.0.2` |
| `@deepseek-ai/cordis-plugin-hmr` | `1.0.17` |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.4` |
| `@deepseek-ai/cordis-plugin-logger-console` | `1.0.2` |
| `@deepseek-ai/schemastery` | `3.18.2` |

这些包直接使用 npm 发布产物并在 `package.json` 中精确锁版本；Wish 不复制 DeepSeek
Harness 的 `vendor/`。`node-addon-require-builtin@0.1.4` 同样被精确锁定，它是 Loader
访问 Node 内部 ESM loader、从而让 HMR 在普通 Wish 启动命令下工作的运行时配套依赖。

Wish 的 Node 基线是 `^22.19.0 || >=24.0.0`。Cordis Core 等包虽然可以在 Node 20
导入，但 HMR 明确不支持 Node 20；最高目标包含 HMR，因此不保留一个只能运行部分插件
栈的 Node 版本。T0 已分别在 Node 22.19.0、24.9.0 和 24.12.0 验证，覆盖 Node 24
内部 ESM loader 接口切换前后的发布包行为；开发和运行 Wish 前必须先切换到受支持版本。

运行 T0 验收：

```bash
npm run test:cordis-baseline
```

验收覆盖发布包与 lockfile 精确版本、ESM 导入、`inject` 的 PENDING/激活/释放、effect
回收、Context 隔离、Loader/Include/Group 的 YAML 组合、Schemastery 首次加载与更新
失败、stable id 更新、`disabled` 卸载与恢复，以及 Loader 管理插件的真实 HMR。完整
`npm test` 也包含这项验收。

同一个 Include/EntryTree 内的配置项 `id` 必须全局唯一；即使两个子项位于不同 Group，
也不能重复使用 `provider`、`consumer` 这类局部 id。后续配置使用带能力或隔离域前缀的
稳定 id，避免 Loader 把同 id 条目识别为移动或更新。

## G1：Cordis 拥有进程基座

G1 已把两个产品 bin 切到同一个 `bootstrap()`：bootstrap 创建唯一 Root Context、提供
稳定的 `launch` service、安装 Loader，并通过根 Include 加载随构建发布的
`cordis.yml`。CLI 与 WebUI 是配置树中互斥的 Loader 条目；入口不再装配 Application、
Server、Terminal 或信号处理器。

```text
wish / wish-webui bin
        └── bootstrap()
              └── Cordis Root Context
                    └── Loader
                          └── Include → cordis.yml
                                └── app Group
                                      ├── private Wish service realm
                                      ├── sessions
                                      ├── models
                                      ├── model adapters
                                      ├── contextEngine
                                      ├── compaction
                                      ├── tools
                                      ├── read / write / edit / grep / bash
                                      ├── agentLoop
                                      ├── runtime / runEngine
                                      ├── agents
                                      ├── application
                                      ├── cli
                                      └── webui
```

Root dispose 会回收 CLI Terminal/信号监听或 WebUI Server；启动失败和永久 PENDING
条目都会让 bootstrap 失败，并先清理已经启动的部分树。

`BootstrappedProcess.context` 始终是进程 Root，只暴露 `launch`、Loader 等进程能力；
`BootstrappedProcess.surfaceContext` 是选中 surface 的派生 Context，用于访问该 surface
所在 realm 的业务 service。两者分开后，Root 所有权不需要通过把业务 service 泄漏到
全局 realm 来证明。

运行 G1 验收：

```bash
npm run test:cordis-boot
```

该验收包含入口防绕过检查、Root/Loader/Include 真实装载、选定 surface 激活、PENDING
启动失败与部分 effect 回收、构建后 CLI 子进程，以及构建后 WebUI 启动、HTTP 请求和
SIGTERM 关闭。

## G2：迁移期 Application 边界（已由 G9 收口）

G2 曾用一个临时 service 集中隔离迁移前的
`createWishHostApplication()` / `createWishApplication()` 组合。CLI 和 WebUI surface
先停止直接导入 Application factory，并验证 service 缺失时 PENDING、provider 卸载时
dispose、恢复后重新激活。

G9 已删除这项迁移支架及两个 factory。当前 surface 声明
`inject = ["launch", "application"]`；
缺少 provider 时保持 PENDING，provider 卸载会 dispose consumer，恢复后重新激活。

正式 service 仍保持 `open()` 惰性语义，所以 `wish --help` 和 `wish --version` 不解析
Models 配置，也不创建 Runtime generation。

运行 G2 验收：

```bash
npm run test:application-service
```

验收覆盖生产调用点防绕过、真实 CLI surface 缺失 service 时 PENDING、service 的卸载与
恢复、consumer effect 回收，以及 CLI help/version 的惰性创建。

## G3 基础设施：真实配置与重载控制面

当前实现把生产配置来源固定为以下优先级：

1. `bootstrap({ configurationFile })`；
2. `CORDIS_CONFIG`；
3. 随构建发布的默认 `cordis.yml`。

字符串路径相对 `launch.cwd` 解析；URL 必须使用 `file:`。Cordis 配置及其 `!!js` 表达式
和插件都能执行本地代码，因此外部 profile 是受信任的代码边界，不应加载来源不明的文件。
最终使用的绝对路径和来源分别暴露为 `launch.configurationFile` 与
`launch.configurationSource`，便于诊断而不重新读取环境。`argv` 与路径是启动快照；
`environment` 保留调用方提供的运行时引用，以便 Provider 在实际调用时读取凭据。

Root 为配置树注册 `include`、`group`、`timer`、`hmr`、`sessions`、`models`、三个 Model
Adapter、`context-engine`、`compaction`、`tools`、五个 Basic Tool、`agent-loop`、`runtime`、`application`、`cli` 和
`webui` builtins。因此位于任意
目录的 profile 都能写
`cordis:group`、`cordis:sessions`、`cordis:models`、`cordis:model-openai-responses`、
`cordis:context-engine`、`cordis:compaction`、`cordis:tools`、`cordis:read`、`cordis:agent-loop`、`cordis:runtime`、`cordis:application`、
`cordis:cli` 等稳定名称，
不需要在 profile 目录复制 Wish 或安装另一份 Cordis。默认 profile 使用 `app` Group
包住这些能力与两个 surface；Group 更新失败会回滚到 last-known-good 子树。

模块 HMR 默认关闭。设置 `CORDIS_HMR=1` 后，默认 profile 会启用 HMR；自定义 profile
也可以显式配置 `cordis:hmr`。HMR 会监视 Loader 管理的 Include，在配置变化时调用其
事务性 refresh：合法更新按 stable id 生效；schema 无效时会清理失败尝试涉及的 generation，
用 last-known-good 配置重新激活，并通过 Root 的 stderr diagnostics 报告失败。
`disabled` 会卸载目标 fiber，Root dispose 会关闭 watcher、diagnostics 和剩余 effect。

运行配置控制面验收：

```bash
npm run test:cordis-config
```

该验收覆盖显式配置覆盖环境配置、相对路径解析、无效路径 fail-fast，以及构建后真实
WebUI 进程从外部 profile 启动；随后在同一进程内验证有效更新、schema 无效回滚、
`disabled` 卸载、重新启用、HTTP 存活和最终清理。

### 插件拥有自己的配置

G3 没有建立全局 config service。Sessions 已接管默认数据目录字段，Models 已接管模型
来源与选择字段，ContextEngine 与 Compaction 已接管各自的预算字段；`application`
的 Schemastery `Config` 不重复拥有业务字段；Runtime Config 拥有 `maxSteps` 与
`generationDrainTimeoutMs`，WebUI Config 只拥有
监听地址和 workspace。CLI 显式参数作为最高优先级覆盖；启动器只提供 `launch` 事实，
不解释这些字段。

普通 Host/WebUI 配置加载器不再隐式读取 `WISH_*`。随构建发布的默认 profile 在 Loader
边界显式把兼容环境变量映射到插件 Config；外部 profile 则完全拥有自己的普通配置，环境
只继续提供 Provider 凭据和环境 header。具体字段与优先级记录在 `src/apps/README.md`。

运行应用配置根验收：

```bash
npm run test:app-plugin-config
```

## G4：生命周期与 Effect

所有长生命周期活动现在都先注册到拥有它的 Cordis fiber：CLI 的执行 Promise、Terminal
和信号订阅位于同一个 effect；WebUI 的异步 Server setup 本身位于 async effect 内，不再
先 `await start`、后补 disposer。因此 dependency generation 在 setup 期间失效时，Cordis
也会等待 setup 收敛并立即执行相应 disposer。WebUI 还按 surface fiber 串行化 generation
lease；Group 回滚和 provider/config 同批更新即使让同一 fiber 的 setup 交错，下一代也必须
先关闭上一代的 Server 与信号订阅，不能同时持有两个监听端口。

WebUI Server 关闭顺序是：关闭请求准入并传播 shutdown signal，fail closed 地关闭 pending
approval，关闭 HTTP/SSE，最后等待这些 Run 的原 completion 全部收敛。普通独立 App 由
Server 对本代活动 Run 发一次 shutdown abort；Loader-managed App 从 G8 起把这项所有权
交给共享的 `RunGeneration`。关闭不会创建新 Run，也不会根据缺失终态重放 Tool。

运行 G4 验收：

```bash
npm run test:cordis-lifecycle
```

验收覆盖 async setup 的所有权边界、provider 消失后的 consumer PENDING、全部 surface
effect 清零、Server 端口释放与 service 恢复后的重新激活；同时覆盖 Application provider 与
WebUI 配置同批更新、旧端口回收，以及活动 Run 的单次 abort、completion 排空和零重放。

## G5：Tools 进入业务依赖图

`src/tools/service.ts` 现在提供 Cordis `tools` service，内部持有纯 Core
`ToolRegistry<BasicToolContext>`。Read、Write、Edit、Grep、Bash 分别是独立 Loader 插件；
它们调用 `ctx.tools.register()` 时，注销 effect 归调用插件自己的 fiber 所有。依赖缺失时
Tool 插件保持 PENDING，service 出现后激活；单个条目 disabled 或卸载只移除自己的 Tool，
恢复后重新注册；service generation 消失则清空旧 Registry 并让所有 Tool consumer 回到
PENDING。

`agentLoop` service 现在注入 `tools`，并用共享 Registry 构造 executor/scheduler；
`application` 通过 `agents` 间接取得完整 Step pipeline。Application 不再集中注册生产 Basic
Tools，每个新 Step 从该 Registry 获取当前快照，所以单个 Tool 配置变化不要求重建
CLI/WebUI 或旧 Application graph。

运行 G5 验收：

```bash
npm run test:cordis-tools
```

验收覆盖 service PENDING/激活/消失、调用 fiber 的 effect 所有权、单 Tool 卸载与恢复、
Root cleanup、默认 Loader stable id 更新，以及同一个 Application 的后续 Run 能看到动态
变化后的 Tool 集合。

## G6.1：Sessions Service 化

`src/sessions/service.ts` 提供 `sessions` service，拥有 `FileSessionStore → SessionManager →
SessionHistoryAdapter` 的构造。纯 Sessions 事实层、Store Port、Context/Compaction Port
均保持不知道 Cordis。`agentLoop` service 取得 Sessions resources，把 manager 交给兼容
Application，并让 ContextEngine/Compaction 分别消费两个 history view；
`ApplicationFacade` 不创建或读取这些对象。

Sessions Config 拥有默认数据目录，路径相对 `launch.cwd`，缺省为
`<launch.homeDirectory>/.wish`。为保留 CLI `--data-dir` 的最高优先级，service 通过
`open(resolvedDataDirectory)` 创建或复用对应目录的 Session graph；构造权仍在 Sessions
fiber，不会回到 CLI 或 Application。配置 generation 卸载会使 Application 和 surface consumer
按依赖图释放，恢复后从同一文件目录重新读取原有事实。

运行 G6.1 验收：

```bash
npm run test:cordis-sessions
```

验收覆盖 PENDING/激活/释放/重激活、stable-id disabled、schema 首次加载和 update 失败、
跨 generation 文件持久化、CLI data-directory 接缝，以及原有 Sessions 事务与 App 组合。

## G6.2：Models Service 化

`src/models/service.ts` 提供 `models` service，拥有 Models 配置来源、动态协议 Registry、
usage estimator 与 Application 使用的完整请求资源。三个内置协议不在 Service 构造函数
中注册，而是由 `src/models/plugins.ts` 的独立插件注入 `models` 后贡献 Adapter；注册
effect 属于调用插件 fiber。

`application` 通过 `models.load()` 保留 Loader Config 和 CLI `--models-config`
的优先级；`agentLoop` service 再通过 `models.open()` 取得 `ConfiguredModel →
UsageResolvingModel → RetryingModel` 与 request counter。`ApplicationFacade` 只消费
模型选择 view，不再构造 Registry、estimator 或模型栈。Provider 凭据继续在每次调用时
读取，不进入配置快照。

```bash
npm run test:cordis-models
```

验收覆盖 Adapter PENDING/注册/撤销/恢复、Service 消失后的 consumer 回退、旧模型栈对
动态协议变化的可见性、凭据轮换、stable-id update/disabled、schema 回滚和 Root cleanup。

## G6.3：ContextEngine 与 Compaction Service 化

`src/context/service.ts` 提供 `contextEngine`，注入 Sessions/Models 并拥有
`FileToolResultArchive → ContextBundle` 的生产构造。`src/compaction/service.ts` 提供
`compaction`，注入相同上游能力并拥有
`ModelCompactionSummarizer → SessionCompactor` 的生产构造。两者的 budget 字段已经从
旧汇总配置移到各自 Config。

`agentLoop` service 现在消费完整 `ContextBundle` 和 `ContextOverflowCompactor`；
`ApplicationFacade` 不看见或创建 archive、Context graph、summarizer、compactor。
纯领域 Port/算法仍不知道 Cordis。任一 service 的 stable-id update/disabled 都通过
依赖图释放 agentLoop/runEngine/agents/application/surface generation，恢复后再激活。

```bash
npm run test:cordis-context
```

验收覆盖双 service 的 PENDING/激活/释放/重激活、构造边界、stable-id update/disabled、
schema 失败保留 last-known-good、Application consumer 回退以及 Root effect cleanup。

## G6.4a：AgentLoop Service 化

`src/core/agent-loop/service.ts` 提供 `agentLoop` service，注入 Sessions、Models、
ContextEngine、Compaction 和 Tools，拥有 `ToolExecutor → BoundedToolScheduler → Core
AgentLoop → ContextOverflowRecoveryPipeline → SessionTranscriptPipeline` 的生产构造。
它把最终 `stepPipeline` 和 Application facade 仍需的窄资源交给 Runtime service。

`ApplicationFacade` 不构造 Tool 执行、AgentLoop、超限恢复或 transcript
pipeline。Core 实现继续不知道 Cordis。Loader 的
`agent-loop` stable id 支持配置更新、schema last-known-good、disabled 卸载与恢复；
上游 service generation 变化会通过注入图释放并重建其下游。

```bash
npm run test:cordis-agent-loop
```

验收同时覆盖直接 service 生命周期、effect cleanup、生产构造边界，以及原有 AgentLoop
和 Apps 组合行为。

## G6.4b：Runtime Service 化

`src/core/runtime/service.ts` 提供 Loader 名称 `cordis:runtime`，注入 AgentLoop 并拥有 Core
Runtime 的生产构造。Cordis 已保留 `ctx.runtime` accessor，因此业务 Context 键明确使用
`runEngine`。它返回当前 Application generation 使用的 Runtime、Sessions 和 Models 窄
资源；`ApplicationFacade` 不 import 或实例化 Core Runtime。

`maxSteps` 由 runtime Config 拥有。合法 stable-id 更新会创建新
Runtime generation；非法 schema 保留 last-known-good；disabled 或 AgentLoop 缺失会让
agents/application/surface consumer 回到 PENDING。

```bash
npm run test:cordis-runtime
```

验收还用持续 `continue` 的 Step pipeline 证明 `maxSteps` 实际约束新 Core Runtime，并
重跑纯 Runtime 状态机与 Apps 组合测试。

## G6.4c：Agent Service 化

`src/core/agent/service.ts` 提供 `agents` service，注入 `runEngine`，拥有默认 Agent
definition 与 Core Agent 的生产构造。`agentId`、`agentInstructions` 由 `agents` Config
拥有；内置 profile 继续显式映射相同兼容环境变量。

`application.open()` 调用 `ctx.agents.open()`，取得 Agent、Runtime、Sessions 和 Models，
再构造只包装现成资源的 `ApplicationFacade`。合法 stable-id 更新、schema
last-known-good、disabled、依赖 PENDING 与 effect cleanup 均由专项验收覆盖。

```bash
npm run test:cordis-agent
```

## G7：Application service realm

默认 `cordis.yml` 的 `app` Group 为以下业务 service 建立 entry-local realm：

```text
sessions / models / contextEngine / compaction / tools
agentLoop / runEngine / agents / application
```

Provider、其注册插件和所有 consumer 都位于同一个 Group 内，因此 Models Adapter 与
Tool 注册会进入正确的局部 Registry；Root 只共享 `launch`、Loader、Timer 和 HMR。
同一 Root 下第二个 application Group 可以再次提供整套同名 service，不会覆盖第一套，
一侧的 stable-id 更新、provider disabled、PENDING、恢复和 effect cleanup 也不会触碰
另一侧。

`Application` 的内部 provider fiber 显式声明与外层插件相同的 inject。这样 Cordis
在 Service 方法调用时恢复 provider scope，CLI/WebUI 仍只依赖 `launch` 与
`application`，不需要伪造一份传递依赖清单。

```bash
npm run test:cordis-isolation
```

专项验收覆盖默认 profile 不向 Root 泄漏业务 service、`surfaceContext` 解析，以及两套
完整业务图的独立 Sessions、Model Adapter Registry、Tool Registry、Agent/Runtime 配置、
单 realm 更新、卸载与恢复。

Cordis 的 fiber cleanup 不会替 Wish 判断业务恢复语义。未知状态的 Tool side effect 绝不能
因为 reload 自动重放。

## G8：Run generation 与安全 HMR

`runEngine.open()` 不再把裸 Core Runtime 直接交给 Agent，而是为这一份不可变依赖图创建
唯一 `RunGeneration`。它是 transport-neutral 的 Runtime adapter，Core Runtime、AgentLoop
和 Tool 算法仍不知道 Cordis。

安全切换固定为：

```text
旧代 accepting
  -> retiring（同步拒绝任何新 Run）
  -> 每个活动 Run 一次显式 abort
  -> 等待原 completion；不重放 Run/Tool
  -> retired
  -> Cordis 才激活新代 consumer
```

CLI/WebUI 都能取得同一个 generation owner；WebUI 不再与它重复发送 shutdown abort。
`generationDrainTimeoutMs` 缺省 30000ms，默认 profile 可由
`WISH_RUN_GENERATION_DRAIN_TIMEOUT_MS` 显式映射。deadline 到达时会用
`run_generation_drain_timeout` 使 launch 失败，但 dispose 继续等待真实 completion，绝不
通过 timeout 放行新代。未知 Tool side effect 因而仍是未知，不能由 HMR 推断为可重试。

```bash
npm run test:run-generation
```

专项验收覆盖准入关闭、单次 abort、原 completion 排空、超时 fail-closed、零重放、WebUI
generation 委托，以及 Cordis Runtime provider 更新中“旧代 retired 后新代才 active”。它还
通过 Loader stable id 在活动模型流期间更新 Runtime，验证旧流关闭、同端口新 WebUI 激活、
Session 保留且模型请求次数仍为 1。

## G9：删除迁移装配根

G0-G9 已完成。CLI/WebUI 直接消费正式 `application` Service；旧 Loader row、临时
service 和两个 Application factory 均已删除。产品运行时唯一装配路径是
`bin → bootstrap → Root Context → Loader/Include → cordis.yml → Application service`。
非 Cordis 嵌入只可显式构造 `ApplicationFacade`，不会成为第二条产品启动路径。
