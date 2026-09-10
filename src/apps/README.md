# Apps

`src/apps/` 是 Wish 的 transport、Application service 与公开门面层。产品仍只提供 CLI 和 WebUI 两个表面，
但进程入口已经由 `src/boot/bootstrap.ts` 统一拥有；Apps 不再作为进程组合根。

G1 的进程链路是：

```text
wish / wish-webui bin
        └── Cordis bootstrap
              └── Loader → Include → cordis.yml
                                      ├── sessions
                                      ├── models + protocol plugins
                                      ├── contextEngine + compaction
                                      ├── tools + Basic Tool plugins
                                      ├── agentLoop
                                      ├── runtime / runEngine
                                      ├── agents
                                      ├── application service
                                      ├── CLI surface ───┐
                                      └── WebUI surface ─┴── WishApplication
```

`WishApplication` 是 Loader-managed `application` service 打开的共享门面，
不是进程 Owner，也不是第三个产品入口。当前包级已经公开
`wish/apps/cli` 与 `wish/apps/webui`，并分别提供 `wish`、`wish-webui` bin。

## 当前进度

T0 已定义最小契约，T1 已实现共享组合根，T2 已实现首个 CLI 入口，
T3 已把 CLI 运行中控制接到 Runtime，T4 已实现 WebUI 后端 API，T5 已实现首个浏览器
界面。当前完成：

- Apps 的职责、依赖方向和两个入口边界；
- CLI/WebUI bin 只进入 Cordis bootstrap，不再自行装配 Application；
- 正式 `application` Service 拥有业务图到 transport-neutral 门面的最终装配；
- CLI/WebUI 只注入 `application`，不再导入或调用任何 Application factory；
- `agentLoop` 注入 Cordis `sessions`、`models`、`contextEngine`、`compaction` 与 `tools`；
- `runEngine` 注入 `agentLoop` 并构造 Core Runtime，`agents` 注入它并构造 Core Agent；
- `application` 只消费 `agents` 返回的现成业务资源；
- CLI/WebUI Loader 插件各自声明并校验自己的启动配置；
- `WishAgentConfiguration` 与 `WishRunPayload`；
- 与 Core 精确对应的 Run handle、completion、control 和 output event 类型；
- CLI/WebUI 共用的 Session 与 Run 操作门面；
- workspace facts 的外部解析 Port；
- `ApplicationFacade` 作为显式非 Cordis 嵌入构造类；
- File Session 与 Tool Result archive 的统一数据根；
- Run 启动前的 Session 存在性、Agent 归属和 archived 状态检查；
- Run 级模型固定，以及缺少 Tool approval 时的 fail-closed 行为；
- 正常 Tool 链路和 Context 超限恢复的组合级验收；
- CLI 的显式 interactive/one-shot 模式、Session 创建与继续；
- 同一个交互 Session 跨普通输入启动多个顺序 Run；
- `OutputEvent` 的增量文本、reasoning、模型重试和 Tool 状态终端渲染；
- TTY 一次性 Tool 审批，以及非 TTY fail-closed；
- 运行中 `SIGINT` 中止当前 Run、重复信号强制退出和有界退出等待；
- 活动 Run 中普通输入到 `steer`、`/follow-up` 到新 UserTurn、`/abort` 到取消的
  确定性映射；
- Tool approval 与运行中控制共用 stdin 时的单读取协调；
- Runtime control receipt 以及 steer 送达、follow-up 出队事件的终端可见性；
- WebUI Session 创建、列表、读取、改名、archive 和完整 transcript API；
- WebUI Run 提交、进程内查询、显式 control 与按 Runtime cursor 回放的 SSE；
- SSE 断开只停止观察，Run 继续执行；服务关闭才显式 abort 活动 Run；
- WebUI 一次性 Tool approval 的 pending、推送、决策、超时和取消；
- WebUI 的 Session 列表、规范 transcript、流式回答、运行详情和一次性审批界面；
- 运行中输入明确区分 steer 与 follow-up，不以普通发送按钮猜测控制语义；
- 暖灰/墨色/陶土色主题 token、系统深色模式、桌面三栏与窄屏抽屉布局；
- 无内联脚本的 CSP、增量流式渲染、近底部自动滚动和有界活动列表；
- stdout/stderr 分离：模型正文写 stdout，提示、审批和诊断写 stderr。

首版 Apps 闭环已经完成。WebUI 前端只暂存活动 Run 的增量展示；Run 终态后重新读取
Sessions 规范 transcript，不在浏览器建立第二份 conversation、message 或 Runtime 状态源。

## 目录演进

目录按实际阶段增加，不预先创建空文件：

```text
src/apps/
├── README.md
├── types.ts               # T0：共享最小契约
├── application.ts         # transport-neutral 门面；供 service 与显式嵌入复用
├── service.ts             # G9：正式 Application Service
├── config.ts              # T2：CLI/WebUI 共用的进程级启动配置
├── cli/                   # T2：入口/参数/审批/输出；T3：运行中控制（已完成）
└── webui/                 # T4：Server/API/审批；T5：静态页面（均已完成）
```

`service.ts` 是产品组合边界；`application.ts` 只实现门面行为，`config.ts` 只解析共享
默认值。三者都不是新的产品入口，也不拥有进程启动链。

## G9：正式 Application service

`src/apps/service.ts` 提供正式 `application` Service。它注入 `launch`、`sessions`、
`models`、`contextEngine`、`compaction` 与 `agents`，通过 `resolve()` 合并当前 service
generation 和 surface 覆盖，通过 `open()` 打开 Agent/Runtime 资源并返回
`ApplicationFacade`。CLI/WebUI surface 都只注入这个 Service。

旧 `legacy` Loader row、`legacyApplication` service、`createWishHostApplication()` 和
`createWishApplication()` 已删除。CLI 的独立测试或外部嵌入若不使用 Cordis，必须显式
构造 `ApplicationFacade` 并自行提供完整依赖；这条 API 不参与产品启动。
Help/Version 仍保持惰性，不调用 `application.open()`。

运行验收：

```bash
npm run test:application-service
```

## 固定组合顺序

T1 复用已经完成的模块，没有在 Apps 重写它们：

```text
Cordis Sessions service
  → FileSessionStore
  → SessionManager
  → SessionHistoryAdapter

Cordis Models service
  → ConfiguredModelStack
  → ModelRequestTokenCounter

Cordis ContextEngine service
  → FileToolResultArchive
  → ContextBundle

Cordis Compaction service
  → ModelCompactionSummarizer
  → SessionCompactor

Cordis AgentLoop service
  → Tools service / dynamic Registry
  → ToolApprovalPort
  → ToolExecutor
  → BoundedToolScheduler
  → Core AgentLoop
  → ContextOverflowRecoveryPipeline
  → SessionTranscriptPipeline

Cordis Runtime service / ctx.runEngine
  → Runtime

Cordis Agents service / ctx.agents
  → Agent

Cordis Application service
  → WishApplication facade
```

Step Pipeline 的包装顺序固定为：

```text
SessionTranscriptPipeline
  └── ContextOverflowRecoveryPipeline
      └── AgentLoop
```

外层 Sessions pipeline 只有在内部 Step 成功后才提交 Assistant/Tool suffix；Compaction
只响应 Context 明确产生的 `context_over_budget`，追加一个 checkpoint 后有界重试一次。

`ApplicationFacade` 只接收 Session manager、用于 Run 选择校验的 `configuredModel` 和
已经构造好的 Agent。Tool executor/scheduler、Core AgentLoop、
Context 超限恢复和 Session transcript pipeline 由 `cordis:agent-loop` 构造；Core Runtime
由 `cordis:runtime` 构造；Core Agent 由 `cordis:agents` 构造。Application 只保留 Session、
模型选择和公开门面的适配逻辑。

`config.ts` 只补进程级默认值并调用 Models 配置加载器：默认数据目录是 `~/.wish`，
默认 Agent id 是 `wish`，Context/Compaction budget 根据默认模型能力给出保守初值。
它不再读取非秘密 `WISH_*` 启动参数；这些值必须由调用方显式传入。

Cordis profile 的来源是 `bootstrap()` 显式路径 → `CORDIS_CONFIG` → 随构建发布的
`cordis.yml`。生产链上的普通配置优先级是：CLI 显式参数 → Loader 插件 Config → 产品
默认值。默认 profile 为兼容现有命令，把下列环境变量显式映射到 `sessions` / `models` /
`context-engine` / `compaction` / `runtime` / `agents` / `webui` 条目；外部 profile 不会隐式继承这些变量：

- `WISH_DATA_DIR`、`WISH_AGENT_ID`、`WISH_AGENT_INSTRUCTIONS`；
- Models 已有的 `WISH_MODELS_CONFIG`、`WISH_MODELS_JSON`、`WISH_MODEL`、
  `WISH_FALLBACK_MODELS` 与 `WISH_MODEL_MAX_RETRIES`；
- `WISH_CONTEXT_RESERVED_OUTPUT_TOKENS`；
- `WISH_COMPACTION_KEEP_RECENT_TOKENS`、
  `WISH_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS`；
- `WISH_MAX_STEPS`、`WISH_RUN_GENERATION_DRAIN_TIMEOUT_MS`；
- WebUI 额外使用 `WISH_WEBUI_HOST`、`WISH_WEBUI_PORT` 和
  `WISH_WEBUI_WORKSPACE_ROOT`；默认只监听 `127.0.0.1:8790`。

Provider 密钥仍只按 Models 配置声明的环境变量在调用时读取，不写入 Session 或 Apps
配置文件。

## G3：cordis.yml 成为配置根

不存在一个汇总所有模块设置的全局 config service。每个 Loader 插件通过自己的
Schemastery `Config` 声明它拥有的字段：`sessions` 拥有默认数据目录，`models` 拥有
Models 来源与进程选择，`context-engine` 拥有 `reservedOutputTokens`，`compaction`
拥有 `keepRecentTokens` 与 `summaryMaxOutputTokens`；`runtime` 拥有 `maxSteps` 与
`generationDrainTimeoutMs`；
`agents` 拥有 `agentId` 与 `agentInstructions`；`application` 没有重复配置；WebUI 只拥有 `host`、`port` 和
`workspaceRoot`；CLI 没有重复的插件配置，`--data-dir` / `--models-config` 作为显式
命令行覆盖传给 `application.open()`。

Models 来源优先级是 `models.configurationPath` →
`models.configurationJson` → `<dataDirectory>/models.json` → generated defaults；
`model`、`fallbackModels` 与 `maxRetries` 是同一条 Loader Config 上的选择覆盖。
`schemaVersion: 1` 仍是完整替换，`schemaVersion: 2` 仍是 generated defaults overlay。

```yaml
- id: sessions
  name: 'cordis:sessions'
  config:
    dataDirectory: './state'

- id: models
  name: 'cordis:models'
  config:
    configurationPath: './models.json'
    maxRetries: 2

- id: model-openai-responses
  name: 'cordis:model-openai-responses'

- id: context-engine
  name: 'cordis:context-engine'
  config:
    reservedOutputTokens: 8192

- id: compaction
  name: 'cordis:compaction'
  config:
    keepRecentTokens: 16384
    summaryMaxOutputTokens: 4096

- id: agent-loop
  name: 'cordis:agent-loop'

- id: runtime
  name: 'cordis:runtime'
  config:
    maxSteps: 32

- id: agents
  name: 'cordis:agents'
  config:
    agentId: 'wish'

- id: application
  name: 'cordis:application'

- id: webui
  name: 'cordis:webui'
  config:
    host: '127.0.0.1'
    port: 8790
    workspaceRoot: './workspace'
```

相对目录按 `launch.cwd` 解析。配置 schema 在插件启动前校验。`agents` 配置更新会创建
新的 Agent service generation，并沿依赖图重建 `application` 与 surface。

WebUI 条目保持同一 stable id 更新时，Loader 会 dispose 旧 Server/Application fiber，
再以新配置启动；无效更新通过 Group 回滚到 last-known-good 配置。CLI 的交互进程仍采用
退出后重新启动的策略，不承诺活动终端会话原地重载。G3 不允许配置层猜测 Tool side
effect 的恢复语义。

运行本阶段验收：

```bash
npm run test:app-plugin-config
```

该验收验证 Agents/WebUI 的字段所有权、共享配置的 service generation 更新，以及真实
构建后 WebUI 进程中的外部 profile 覆盖冲突环境、相对路径、端口热更新、schema 无效
回滚、Session 数据目录连续性和最终 effect 清理。G3 已完成；Tools 已在 G5 提升为
service，Sessions、Models、ContextEngine 与 Compaction 已分别在 G6.1-G6.3 拆出；
AgentLoop、Runtime 与 Agent 已在 G6.4a-G6.4c 拆出；Application 不再构造这三项能力。

## G4：surface 生命周期

CLI 的运行 Promise、Terminal 和 signal subscription 由同一个同步注册的 Cordis effect
持有。WebUI 则把 `startWishWebUiServer()` 放进 async effect 的 setup 内；这样即使
`application` generation 在 Server 启动过程中消失，Cordis 也能等待 setup 完成后
立即关闭它，而不是让已启动资源逃出旧 fiber。额外的 per-fiber generation lease 串行化
Group 回滚与 provider/config 同批更新造成的交错 setup：启动下一代前必须先释放上一代的
Server 和 signal subscription。

WebUI Server generation 只追踪自己启动的 Run。关闭时先停止请求准入并中止 HTTP/SSE
操作，再关闭 pending approval；普通独立 App 仍由 Server 发送 shutdown abort，生产的
Loader-managed App 则由 G8 的共享 Run generation 发送一次 abort。两条路径都等待原
completion，不做 Run replay 或 Tool retry 推断。

运行生命周期验收：

```bash
npm run test:cordis-lifecycle
```

它覆盖 provider 消失/恢复时 WebUI consumer 的 PENDING/重激活、effect 清零和端口回收，
同批 Application/WebUI 更新，以及活动 Run 的单次 abort、completion 排空与零重放。

## G5：动态 Tools 接缝

生产 profile 先启动 `cordis:tools`，再把五个 Basic Tool 作为独立 Loader 条目注册到共享
Registry。`cordis:agent-loop` 注入 `tools` 并用该 Registry 构造 executor/scheduler；
`application` 通过 `agents` 间接消费它。每个新 Step 都取得当前 Tool 列表，因此
单个 Tool 的 disabled、恢复或重载不要求重启 surface。

非 Cordis 嵌入通过显式 `createAgentLoopPipeline()` helper 取得兼容默认 Registry；
`ApplicationFacade` 本身不注册 Tool。G5 验收见：

```bash
npm run test:cordis-tools
```

## G6.1：Sessions 接缝

Sessions 的持久化与 history adapter 现在由 `ctx.sessions` 构造和持有。AgentLoop service
根据最终解析的数据目录调用 `ctx.sessions.open()`，因此 Loader 默认配置和 CLI
`--data-dir` 覆盖都使用正确的 File Store；Application 只消费返回的 manager，两个
history view 分别由 ContextEngine/Compaction 消费，不再 import 或实例化 FileSessionStore。

```bash
npm run test:cordis-sessions
```

## G6.2：Models 接缝

`ctx.models` 现在拥有 Models 配置来源、动态协议 Registry、usage estimator、请求装饰器
顺序和 request counter。OpenAI Chat Completions、OpenAI Responses 与 Anthropic
Messages 是三个注入 `models` 的普通插件；卸载任一插件会撤销它注册的协议，恢复后重新
加入同一 Registry。Application service 调用 `models.load()` 解析配置；AgentLoop service
调用 `models.open()` 取得请求栈，再只把 Application 仍需的 `configuredModel` view 交回。

```bash
npm run test:cordis-models
```

## G6.3：ContextEngine / Compaction 接缝

`ctx.contextEngine` 负责把 Sessions history、Models 窗口/计数能力和文件 Tool Result
Archive 组装为完整 `ContextBundle`；`ctx.compaction` 负责把 Sessions CAS view 与 Models
请求能力组装为 summarizer/compactor。两个 service 分别拥有自己的预算配置和 generation。

AgentLoop service 调用两个 `open()` 并把结果接入 Step pipeline；Application 不再看见
`ContextBundle` 或 compactor。任一 service 更新或消失，AgentLoop、Runtime、Agents、
Application 与 surface consumer 都由 Cordis 释放并回到 PENDING；恢复后使用新 generation。纯
Context/Compaction Port 与算法不知道 Cordis。

```bash
npm run test:cordis-context
```

## G6.4a：AgentLoop 接缝

`ctx.agentLoop` 现在拥有 `ToolExecutor → BoundedToolScheduler → Core AgentLoop →
ContextOverflowRecoveryPipeline → SessionTranscriptPipeline` 的生产构造，并把最终
`stepPipeline` 作为窄 service view 交给 Runtime service。它依赖 G5/G6.1-G6.3 的五项能力，
所以任何上游 generation 的更新与缺失都会沿真实依赖图传播。

`ApplicationFacade` 不 import 或构造上述对象。Core 算法文件仍不依赖 Cordis。

```bash
npm run test:cordis-agent-loop
```

## G6.4b：Runtime 接缝

`cordis:runtime` 提供 Context service `runEngine`。这里不能使用 `ctx.runtime`，因为它是
Cordis 自己的插件 runtime accessor。`runEngine` 注入 `agentLoop`，调用当前 generation
的 `open()` 后构造 Core Runtime，并把 runtime 作为窄能力交给 Application。

`maxSteps` 由 runtime Config 拥有；默认 profile 仍显式兼容
`WISH_MAX_STEPS`。Runtime 更新、禁用或依赖缺失会让 agents/application/surface 回到 PENDING，
恢复后使用新 generation。Application 不再消费 Runtime。

```bash
npm run test:cordis-runtime
```

## G6.4c：Agent 接缝

`cordis:agents` 提供 `ctx.agents`，注入 `runEngine`，拥有默认 Agent definition 和 Core
Agent 构造。`agentId`、`agentInstructions` 由 agents Config 拥有；合法
stable-id 更新会重建下游，非法 schema 保留 last-known-good，disabled 会让 Application 与
surface 回到 PENDING。

`application.open()` 调用 `ctx.agents.open()` 并用现成资源构造门面。至此 G6 的核心业务链
和 G9 的最终装配都已进入 Cordis 依赖图。

```bash
npm run test:cordis-agent
```

## G7：Surface 与隔离 realm

默认 profile 把完整业务图放入 `app` Group 的私有 realm。CLI/WebUI 与 provider 位于
同一派生 Context 下，仍只直接注入 `launch` 和 `application`；进程 Root 不再解析
`sessions`、`models`、`tools`、`runEngine` 等业务 service。

`bootstrap()` 因此同时返回 Root `context` 和选中入口的 `surfaceContext`。前者用于进程
所有权、Loader 操作与最终 dispose，后者用于诊断当前 application realm。两套 app Group
可以各自拥有同名 service、Model Adapter 和 Tool 注册；一侧卸载只让该侧下游进入
PENDING。

```bash
npm run test:cordis-isolation
```

## G8：Run generation 与安全切换

`ctx.runEngine.open()` 为每一份 Application 依赖图创建唯一 `RunGeneration`，Agent 只通过
它访问 Core Runtime。旧代卸载时先同步关闭 `startRun` 准入，再向其活动 Run 各发送一次
`wish-run-generation` abort，并等待原 completion；未完成前新 surface generation 不会
启动。CLI 与 WebUI 消费的是同一个 owner，WebUI 因此不会重复发 shutdown abort。

排空 deadline 由 Runtime Config 的 `generationDrainTimeoutMs` 控制，缺省 30000ms。超时
会报告 `run_generation_drain_timeout` 并让 launch 失败，但不会把旧代标成 `retired`，也
不会放行新代。系统从不自动创建、重试或重放 Run/Tool；未知 side effect 留待后续显式
reconciliation。

```bash
npm run test:run-generation
```

该验收覆盖旧代准入拒绝、单次取消、原 completion 排空、超时 fail-closed、Cordis provider
更新的无重叠顺序、零重放、managed WebUI 关闭委托，以及活动模型流上的 Loader stable-id
更新。

## Session、Run 与 workspace

Apps 必须保持三个身份不混用：

```text
Session
  └── Run
      └── UserTurn
          └── Step
```

- `sessionId` 是跨多个 Run 的持久会话身份。
- `RunInput.scope` 必须等于 `sessionId`，复用 Runtime 的活动 scope 唯一性。
- `Session.scope` 保存该会话所属的 workspace root，不等于 Runtime scope。
- Session 必须在首个 Run 启动前显式创建；`startRun` 先异步读取 Session，拼错 ID
  不能隐式创建新 Session，也不能先启动 Runtime 再补查。
- `WishWorkspaceResolver` 根据 Session 为每个 Step 解析新的 `cwd` 和 workspace
  instructions；Context 只消费解析后的事实。
- Context、Tool Result archive、Compaction target、Session input renderer 和 transcript
  pipeline 必须解析到同一个 `sessionId`。

第一版可以由 App 配置直接提供 workspace instructions；自动向上查找或合并
`AGENTS.md` 等规则不在 T0 中偷偷定义。

## 输入与控制语义

`WishRunPayload` 是 CLI 和 WebUI 共用的普通输入：

```ts
interface WishRunPayload {
  readonly text: string;
  readonly model?: ModelRef;
}
```

可选模型只在一个新 Run 开始时选择。Apps 在 Runtime 启动前把默认值解析成完整
`ModelRef`，同一 Run 的 follow-up 自动沿用它；显式请求切换模型会被拒绝。AgentLoop
仍在首个 Step 后固定自己的 Step memory 模型。

Apps 不根据输入内容猜测运行中的控制类型，只使用界面已声明的确定性
映射：

- `startRun`：为 Session 启动一个新的 Run 和初始 UserTurn；
- `steer`：进入当前 UserTurn 的下一 Step；
- `follow_up`：进入同一 Run 的下一个 UserTurn；
- `abort`：显式请求取消 Run；
- `observeRun`：只观察有序 OutputEvent，不获得 Runtime 内部可变状态。

CLI 命令和 WebUI API 将来可以使用不同语法，但必须映射到同一组 Core control DTO；
排序、容量、去重和送达仍由 Runtime 的 `NextStepInbox` 与 `NextTurnQueue`
负责。

## CLI

T2 采用逐行 CLI，不复制 Pi 的完整全屏 TUI。启动方式是：

```bash
DEEPSEEK_API_KEY=... wish
DEEPSEEK_API_KEY=... wish run "分析这个项目"
printf '%s\n' "分析这个项目" | DEEPSEEK_API_KEY=... wish run

# 自定义完整 Models 配置时：
wish --models-config ./models.json
wish --models-config ./models.json --session <session-id>
```

- `wish` 只在 TTY 中进入交互模式；它不会根据 piped stdin 隐式改变产品语义。
- `wish run` 是显式 one-shot；参数中没有 prompt 时才读取 piped stdin。
- `--cwd` 只用于新 Session；已有 Session 的 workspace 必须来自持久化的
  `Session.scope`，所以不能和 `--session` 同时使用。
- 新 Session 使用第一条输入生成最多 60 个 Unicode 字符的确定性标题，不调用标题模型。
- 交互模式一次只运行一个普通 Run；Run 完成后下一条输入在同一 Session 中启动新 Run。
- 空闲时普通输入启动新 Run，`/exit` 和 `/quit` 退出 CLI。
- 活动 Run 的提示符明示 `Enter=steer`：普通输入确定映射为 `steer`，
  `/steer <text>` 是显式等价写法，`/follow-up <text>` 排队为同一 Run 的新
  UserTurn，`/abort` 取消 Run。
- 活动 Run 中的 `/exit` 与 `/quit` 不会越过 Runtime 关闭进程；需要先使用
  `/abort`。
- CLI 只立即调用 `WishApplication.controlRun()` 并展示 receipt，不保留自己的
  steer/follow-up 队列。
- 非 TTY 不询问 Tool approval，直接拒绝；TTY 的 `y/yes` 只批准当前调用一次。
- Tool approval 需要读取 stdin 时会暂停当前 control prompt，审批结束后恢复；
  终端协调器只解决输入归属，不承担 Runtime 消息队列。
- approval 是授权交互，不是 Sandbox，也不会生成持久 allow rule。
- 模型正文独占 stdout；Session id、workspace、reasoning、Tool 生命周期和错误写 stderr。
- 活动 Run 收到第一次 `SIGINT` 后走 Runtime abort；Run 终态前再次收到信号或等待超过
  5 秒才强制退出。`SIGTERM`/`SIGHUP` 同时请求终止整个 CLI。

## WebUI

WebUI 使用共享 Models/App 环境配置启动：

```bash
DEEPSEEK_API_KEY=... npm run webui
# 自定义完整 Models 配置时：
WISH_MODELS_CONFIG=./models.json npm run webui
# 或构建/安装后运行 wish-webui
```

首版固定接口：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/health` | 进程与 Agent 基本状态 |
| `GET/POST` | `/api/sessions` | 按状态列出或创建 Session |
| `GET/PATCH` | `/api/sessions/:sessionId` | 读取或修改标题 |
| `POST` | `/api/sessions/:sessionId/archive` | archive，不做硬删除 |
| `GET` | `/api/sessions/:sessionId/history` | 读取 Sessions 规范 transcript |
| `GET/POST` | `/api/sessions/:sessionId/runs` | 查询本进程 Run 投影或启动 Run |
| `GET` | `/api/runs/:runId` | 查询本进程保存的 Run 状态与终态 completion |
| `POST` | `/api/runs/:runId/controls` | 显式提交 `steer/follow_up/abort` |
| `GET` | `/api/runs/:runId/events` | Runtime OutputEvent SSE |
| `GET` | `/api/approvals?runId=...` | 查询 pending 一次性审批 |
| `POST` | `/api/approvals/:approvalId` | 用 `{ "approved": boolean }` 决策一次 |

所有变更请求必须使用 `Content-Type: application/json`，未知字段和不合法联合类型会明确
返回 `4xx`。`POST .../runs` 返回 `202`、`runId`、事件地址和控制地址；请求结束或 SSE
断开不会取消 Run。客户端只能通过 control API 主动 abort。

SSE 直接观察 Runtime 的 `RuntimeEventStream`：

- Runtime event 的 SSE `id` 就是数字 `sequence`；重连使用 `Last-Event-ID` 或 `after`；
- 事件缓存过期会产生明确的 `stream.error/event_cursor_expired`，不会伪造完整回放；
- `approval.snapshot/requested/resolved` 与 Runtime event 共用连接，但审批事件不推进
  Runtime cursor；
- heartbeat 只维持连接，不代表 Run checkpoint、进程恢复或 Tool 可安全重放；
- Run 查询只是有界的进程内投影，服务重启后不能当成持久 Runtime Store。

`WebToolApprovalBroker` 只允许当前 Tool 调用一次。批准后仍由 Core 在 dispatch 前重新验证
policy、authority 和 Registry snapshot；重复、过期、取消或未知 approval id 都不能获得
Grant。Server 关闭时会 fail closed 地取消 pending approval，并 abort 由该 Server 启动且
仍活动的 Run。

### 浏览器界面

`GET /` 提供无框架的静态界面，构建时由 `scripts/copy-webui-assets.mjs` 将
`src/apps/webui/public/` 复制到 `dist`。页面分成三块：

```text
Session 列表 │ 规范历史 + 活动 Run 临时输出 │ Run 活动 + Tool approval
```

- 桌面使用三栏，窄屏把 Session 和 Run inspector 变成抽屉；
- Session 可以创建、切换、重命名与 archive，archive 不等于删除；
- 空闲输入只启动新 Run；活动 Run 必须明确点击“送入下一步”或“排队新回合”；
- SSE delta 按 `stepId` 增量展示，只有靠近底部时才跟随滚动，避免重绘整个历史；
- 流式更新不替换 composer DOM，并在快捷键处理时尊重中文输入法 composition 状态；
- Run 终态重新读取 `/history`，然后丢弃临时 delta；
- Markdown 只渲染经过转义的安全子集，远程图片不自动加载；
- approval inspector 展示 Tool 名称、workspace 和调用参数，只能批准当前调用一次；
- HTML 不含内联 script/style，Server 为静态资源发送 CSP、`nosniff` 和 no-referrer。

主题 token 集中在 `public/app.css`：低饱和暖灰作为工作台背景，墨色表示主要结构，陶土色
提示需要注意的动作，森林绿表示运行与完成状态。它保留 PIBot 已验证的信息层次，但没有
沿用其界面主题或把全部事件堆进主对话流。

## Session 事实与界面状态

Sessions 是 CLI 与 WebUI 唯一的持久对话事实源：

- 不创建第二份 Web conversation/message Store；
- User、Assistant、Tool、checkpoint 和 Tool Result archive receipt 从 Sessions 读取；
- Runtime stream delta 只是活动 Run 的临时展示，不追加为另一份历史；
- Run 终态后界面重新读取 Session transcript；
- 标题由 Apps 或以后独立服务决定，Sessions 只保存最终标题；
- 常规入口只 archive Session，不增加硬删除语义。

## 配置与依赖边界

Apps 将负责解析并注入：

- store root、workspace root 和模型配置位置；
- Agent 身份与 agent instructions；
- 默认模型、可选 summary 模型和 Context/Compaction budget；
- Runtime 队列、Step、事件保留等产品级限制；
- CLI 或 WebUI 实现的 `ToolApprovalPort`。

Apps 不负责实现 Provider 协议、Token 算法、Context 投影、摘要算法、Session 事务、Tool
执行或 Runtime 状态机。入口不得通过深层 import 绕过各模块公共出口去修改内部状态。

## 当前安全与持久化限制

- Tool approval 不是 Sandbox。真实 Sandbox 未实现前，WebUI 只能默认监听 loopback，
  Tool 不能自动放行。当前也没有用户认证、TLS 或远程部署边界，不能声称适合公网暴露。
- `FileSessionStore` 当前只保证单进程并发安全。T1 的 CLI/WebUI 共享同一个
  `WishApplication` 设计只保证进程内共用 Store；尚未实现跨进程锁，因此两个进程不能
  同时写同一 data directory。
- Runtime event stream 是有界、进程内事件流。浏览器可在同一进程内按 cursor 重连，
  但服务重启后不能把它当作持久 Event Store。
- 当前没有 Runtime/Tool 中断恢复。已经进入 dispatched 的 Tool 不能根据缺失终态自动
  重放。
- 当前 Anthropic 可以使用服务端精确请求计数；OpenAI Chat Completions 仍可能返回
  `unknown`，Apps 不得伪造预算或把 Provider overflow 偷偷改成无界重试。

## 后续实施顺序

1. T2：实现 CLI 的 Session、普通输入、流式输出和一次性 Tool 审批（已完成）。
2. T3：补 CLI 的 steer、follow-up 与 abort（已完成）。
3. T4：实现 WebUI Session/Run/事件/审批 API（已完成）。
4. T5：实现静态布局、主题 token、组件页面和可自动化的浏览器资源验收（已完成）。

不在 Apps 第一版增加 Workflow、Task、Child Agent、Memory、Skill、Evolution、标题模型、
持久审批规则或 Runtime durability 空壳。

## T0 验收

T0 只要求：

- `types.ts` 能与现有 Core、Context、Sessions 类型组合；
- 没有重复定义 Session history、Runtime control 或 OutputEvent；
- 没有新增 CLI/WebUI 运行时代码或第三个包入口；
- `npm run typecheck` 与 `git diff --check` 通过。

## T1 验收

`scripts/accept-apps-composition.mjs` 从 `WishApplication` 公共门面验证两条路径：

1. 创建 File Session，跨 Run 投影历史，审批并执行 Basic Tool，归档完整 Tool Result，
   原子提交 Assistant/Tool transcript，再通过 Runtime 完成 Run。
2. 使用 Anthropic 精确请求计数明确产生 `context_over_budget`，只总结可压缩的
   `oldEntries`，CAS 追加 checkpoint，并对同一 Step 有界重投影一次。

同时确认 unknown/archived Session 不会启动 Model 请求。T1 不包含 live Provider、跨进程
写入、CLI 终端交互或浏览器验收。

## T2 验收

`scripts/accept-apps-cli.mjs` 验证：

1. CLI 模式和参数是显式、无歧义的，已有 Session 不能被 `--cwd` 改写 workspace。
2. 共享启动配置继续调用 Models parser，并在模型窗口已知时拒绝非法 budget。
3. 交互 CLI 在一个 Session 中顺序启动多个 Run，只对当前 Tool 调用批准一次。
4. piped one-shot 的模型正文只写 stdout，非 TTY Tool 请求 fail closed。
5. 使用真实 `WishApplication`、OpenAI-compatible adapter 和 File Session，以本地 fake
   Provider Response 验证两次 one-shot 能从持久历史投影到第二个模型请求。
6. 活动 Run 的第一次 `SIGINT` 映射成 Runtime abort，CLI 随后仍可回到同一 Session。

运行：

```bash
npm run test:apps-cli
```

这是参数、配置、App 门面、事件渲染和信号控制的进程内验收，不是 live Provider 或真实
PTY 证明；后者应在配置实际 Provider 后单独执行。

## T3 验收

`scripts/accept-apps-cli.mjs` 在 T2 基础上继续验证：

1. 活动 Run 中普通输入只按明示规则映射到 `steer`，命令语法无歧义。
2. Tool approval 可暂停 control prompt，审批回答不会被误当成 steer，且 stdin 不会
   出现并发读取。
3. CLI 将 steer、follow-up 和 abort 直接交给 App 门面，并展示 Runtime 接收或
   拒绝的 receipt。
4. 使用真实 `WishApplication` 与 Runtime，确认 steer 只进入当前 UserTurn 的下一
   Step，follow-up 只创建同一 Run 的新 UserTurn，abort 产生 Run 终态。

T3 验收使用进程内 fake Model adapter 精确控制 Step 时序；它证明了真实
Runtime 队列语义，但仍不是 live Provider 或真实 PTY 手工验收。

## T4 验收

`scripts/accept-apps-webui.mjs` 验证：

1. 一次性 approval broker 的不可变快照、pending 查询、单次决策、abort 与 fail-closed。
2. WebUI 配置继续复用共享 Models/App parser，只增加 host、port 和 workspace root。
3. HTTP Session/Run/control API 的状态码、DTO 和显式 archive 语义。
4. SSE 使用 `Last-Event-ID` 传递 Runtime cursor，断开连接只取消 observer、不 abort Run。
5. 使用真实 `WishApplication`、Runtime、Basic Read Tool 和 File Session，完成
   approval request → HTTP approve → Grant/dispatch → transcript commit → Run terminal。

同时，`scripts/accept-events.mjs` 覆盖慢 observer 在 Runtime 追加终态并立即 close 时仍能
读到完整尾部事件，避免 WebUI 丢失 `user_turn.completed/run.completed`。

运行：

```bash
npm run test:apps-webui
```

该验收会监听 `127.0.0.1` 的临时随机端口，属于真实 HTTP/SSE 和进程内 fake Model
证明；不包含 live Provider、跨进程恢复或公网部署证明。

## T5 验收

`scripts/accept-apps-webui.mjs` 在 T4 基础上继续验证：

1. 构建产物包含 Session、消息、审批和显式 steer/follow-up 控件；
2. 浏览器脚本可被 JavaScript parser 解析，并保留 EventSource、Markdown、滚动跟随等
   关键运行路径；
3. CSS 定义集中主题 token、系统深色模式、窄屏布局和 reduced-motion 退化；
4. 真实 Server 为 `/`、CSS、JS 和 HEAD 请求返回正确资源、Content-Type 与 CSP；
5. HTML 无内联 script/style，用户与模型内容通过安全 DOM 或转义后的 Markdown 子集渲染。

当前自动验收证明静态产物和真实 HTTP 资源链路，不等于人工视觉评审。使用实际 Provider
启动后，仍应在浏览器分别走一次桌面和窄屏的创建 Session、流式回答、Tool approval、
steer、follow-up、abort 与 archive。
