# Apps

`src/apps/` 是 Wish 的 transport、Application service 与公开门面层。产品提供 CLI 和
WebUI 两个 surface；进程启动与依赖图由 `src/boot/bootstrap.ts` 和 `cordis.yml` 统一拥有。

`WishApplication` 是 transport-neutral 门面，不是进程 Owner，也不是第三个产品入口。
包级公开 `wish/apps/cli`、`wish/apps/webui`，并提供 `wish`、`wish-webui` 两个 bin。

## 目录职责

```text
src/apps/
├── types.ts          # surface 共用契约
├── application.ts    # transport-neutral ApplicationFacade
├── service.ts        # Loader-managed application service
├── config.ts         # Application 打开时的配置解析
├── cli/              # 参数、终端、审批、输出与运行控制
└── webui/            # HTTP/SSE、审批 broker 与静态页面
```

`service.ts` 是产品组合边界。`application.ts` 只实现门面行为；非 Cordis 嵌入可以显式构造
`ApplicationFacade` 并自行提供完整依赖，但产品 bin 不走这条路径。Help 和 Version 保持
惰性，不会打开 Application 或解析 Models。

## 组合与依赖边界

生产路径固定为：

```text
Cordis Sessions service -> SessionManager / history views
Cordis Workspace service -> immutable per-Step Workspace Snapshot
CLI | WebUI -> Cordis Approval Hub -> Cordis Permissions service
Cordis Models service -> ConfiguredModel / request stack
Cordis ContextEngine + Compaction services
Cordis Tools service <- Basic Tool plugins
Cordis AgentLoop service -> StepPipeline
Cordis Runtime lifecycle -> startup recovery gate / reconciliation projection
Cordis Runtime service -> RunGeneration
Cordis Agents service -> Agent
Cordis Application service -> ApplicationFacade
CLI | WebUI -> WishApplication
```

Step pipeline 的包装顺序固定为：

```text
SessionTranscriptPipeline
  -> ContextOverflowRecoveryPipeline
  -> AgentLoop
```

只有内部 Step 成功后，Sessions pipeline 才提交 Assistant/Tool suffix。Compaction 只响应
Context 明确返回的 `context_over_budget`，追加 checkpoint 后对同一 Step 最多重投影一次。

Application 负责 Session 操作、模型选择校验和公开 DTO 适配，不实现 Provider 协议、Token
算法、Context 投影、摘要、Session 事务、Tool 执行或 Runtime 状态机。CLI 注入
`launch`、`approval` 与 `application`；WebUI 另外注入 `approvalRules` 用于规则管理。
surface 只收集用户的审批与有效期选择，是否需要审批和是否允许复用由 Permissions 决定。

可选业务模块通过 `SessionFeature` 接口贡献当前 Session 的状态投影、带版本凭证的人工操作，
以及普通用户消息到达前的通知。Application 只注册和转发，不拥有 Plan、Tasks 或 Workflow
状态。CLI `/review` 与 WebUI 的 Session Features 面板共享此接口；Plan 审批与 Workflow
结果核对不是模型可调用的 Tool，也不等同于单次 Tool 权限审批。
WebUI 提供 `GET /api/sessions/:id/features` 与
`POST /api/sessions/:id/features/:key`；后者必须携带显示过的 `action`、`token`，必要时携带
`feedback`。接口先检查 Session 所有权，过期版本按冲突拒绝。普通新消息及 steer/follow-up
会通知业务模块，使尚未批准的 Plan Review 可以继续多轮规划。

每次 `Application.open()` 都创建一个拥有 Session Handle 的 RunGeneration。退役顺序是停止
新 Run、请求取消并等待已有 Run 终态、最后释放 Session Handle。CLI/WebUI 的关闭流程负责
调用 `runGeneration.retire()`；直接调用 Application service 的嵌入方也必须显式退役返回的
generation，不能把 Cordis Provider 卸载当作资源所有权替代品。

## 配置

普通配置优先级是：CLI 显式参数、Loader 插件 Config、产品默认值。默认数据目录是
`~/.wish`，默认 Agent ID 是 `wish`。Models 来源依次为：

```text
models.configurationPath
-> models.configurationJson
-> <dataDirectory>/models.json
-> generated defaults
```

默认 profile 会把下列兼容环境变量映射到相应插件：

- `WISH_DATA_DIR`、`WISH_AGENT_ID`、`WISH_AGENT_INSTRUCTIONS`；
- `WISH_PERMISSION_PROFILE`、`WISH_PERMISSION_POLICY_VERSION`、
  `WISH_AVAILABLE_TOOLS`、`WISH_ALLOWED_CAPABILITIES`；
- `WISH_STORAGE_FILE_ROOT`；
- `WISH_WORKSPACE_INSTRUCTION_FILES`、`WISH_WORKSPACE_REPOSITORY_MARKERS`、
  `WISH_WORKSPACE_MAX_INSTRUCTION_BYTES`、
  `WISH_WORKSPACE_MAX_INSTRUCTION_FILE_BYTES`；
- `WISH_MODELS_CONFIG`、`WISH_MODELS_JSON`、`WISH_MODEL`、
  `WISH_FALLBACK_MODELS`、`WISH_MODEL_MAX_RETRIES`；
- `WISH_CONTEXT_RESERVED_OUTPUT_TOKENS`；
- `WISH_COMPACTION_KEEP_RECENT_TOKENS`、
  `WISH_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS`；
- `WISH_MAX_STEPS`、`WISH_RUN_GENERATION_DRAIN_TIMEOUT_MS`；
- `WISH_WEBUI_HOST`、`WISH_WEBUI_PORT`、`WISH_WEBUI_WORKSPACE_ROOT`。

`WISH_AGENT_INSTRUCTIONS` 是追加在 Wish 稳定基础 Prompt 之后的部署级或 Agent 级
指令；未设置时为空。身份、权威边界、通用行为和输出风格由
`system-prompt-base` 统一提供。

外部 Cordis profile 直接配置各 service，不会隐式继承这些普通变量。Provider 密钥只按
Models 配置声明的环境变量在调用时读取。

## Session、Run 与 workspace

```text
Session
  -> Run
      -> UserTurn
          -> Step
```

- `sessionId` 是跨 Run 的持久会话身份。
- `RunInput.scope` 等于 `sessionId`，借用 Runtime 的活动 scope 唯一性。
- `Session.scope` 保存 workspace root，不等于 Runtime scope。
- Session 必须在首个 Run 前显式创建；未知或 archived Session 不能启动模型请求。
- `WorkspaceService` 按 Session 为每个 Step 解析一次不可变 Snapshot；Session 只保存用户选择的
  root，不保存 canonical path、repository 或 instruction 缓存。
- Context 与 Tools 都由该 Snapshot 驱动：Context 投影 identity/revision/instructions；
  Permissions 固定 Step authority；Tools 获得 Workspace、Permission Snapshot、Filesystem、Shell 和等于
  `snapshot.root` 的兼容 `cwd`。
- Context、Tool Result archive、Compaction、input renderer 和 transcript pipeline 必须解析到
  同一个 `sessionId`。

Sessions 是 CLI 与 WebUI 唯一的持久对话事实源。Runtime delta 只用于活动 Run 的临时展示；
Run 终态后界面重新读取规范 transcript，不维护第二份 conversation/message store。

Skills 浏览和 Memory 候选审核通过通用 `SessionFeature` 接入，CLI／WebUI 不导入对应
业务实现。浏览 Skill 只展示内容，不代表激活；审核 Memory 使用当前候选的版本和 digest，
模型文字不能代替人类操作。子 Agent 提案保留子会话来源，审核路由由 Host 指向父会话。

## 输入与控制

`WishRunPayload` 包含普通文本、可选模型和可选思考强度。模型与思考强度只在新 Run
开始时选择并固定；follow-up 沿用同一选择，不能在运行中切换。WebUI 的会话思考设置
属于 Models 模块，新选择只影响下一个新 Run，不回写活动 Step 或排队的 follow-up。
新建会话输入框先保留 Browser 草稿及思考选择，不创建 Host Session；首次发送按
“创建 Session → 应用可选能力设置 → 启动首个 Run”的顺序执行。能力设置失败时保留
已创建的 Session 和草稿，明确告知首条消息未发送，不会退回默认强度偷偷发送。

Apps 不根据正文猜测控制意图，只提供确定映射：

- `startRun`：为 Session 启动新 Run 和初始 UserTurn；
- `steer`：进入当前 UserTurn 的下一 Step；
- `follow_up`：在同一 Run 中创建下一个 UserTurn；
- `abort`：请求取消 Run；
- `observeRun`：观察有序 OutputEvent，不暴露 Runtime 内部可变状态。

排序、容量、去重与送达由 Runtime 的 `NextStepInbox` 和 `NextTurnQueue` 保证。

## CLI

```bash
DEEPSEEK_API_KEY=... wish
DEEPSEEK_API_KEY=... wish run "分析这个项目"
printf '%s\n' "分析这个项目" | DEEPSEEK_API_KEY=... wish run
wish --models-config ./models.json
wish --models-config ./models.json --session <session-id>
wish recovery list
wish recovery resolve --resolution-id <id> --run-id <id> --user-turn-id <id> \
  --step-id <id> --call-id <id> --outcome confirmed-not-completed \
  --reason "已核对外部状态"
```

- `wish` 只在 TTY 中进入逐行交互模式；`wish run` 是显式 one-shot。
- `wish child` 是 host launcher 专用的内部 TTY 协议，不是公开的任意进程入口。它要求
  固定 child/Session/Run ID、私有 prompt 文件、exchange data directory、cwd 和独立 data
  directory；完成后以原子文件写出结构化结果。任务正文不进入 argv。
- one-shot 没有 prompt 参数时才读取 piped stdin。
- `--cwd` 只用于新 Session，不能与 `--session` 同时使用。
- 新 Session 用首条输入生成最多 60 个 Unicode 字符的确定性标题，不调用模型。
- 活动 Run 中普通输入和 `/steer` 都映射为 `steer`；`/follow-up` 创建新 UserTurn；
  `/abort` 取消 Run。
- `/exit` 和 `/quit` 不能绕过活动 Runtime；应先 abort。
- 非 TTY Tool approval 会 fail closed；TTY 可选择 `y`（once）、`r`（run）、`s`（session）
  或 `w`（workspace），其他输入拒绝。
- 模型正文写 stdout；提示、reasoning、Tool 生命周期与错误写 stderr。
- 第一次 `SIGINT` 请求 Runtime abort；终态前再次收到信号或等待超过 5 秒才强制退出。
- `recovery list` 输出当前 durable recovery 投影；`recovery resolve` 要求显式目标、结论、
  reason 和调用方拥有的幂等 `resolutionId`，不创建 Session/Run，也不重放 Tool。

## WebUI

```bash
# 执行记录界面、独立插件管理与 Settings；已有密钥环境时直接 npm run webui
DEEPSEEK_API_KEY=... npm run webui
WISH_MODELS_CONFIG=./models.json npm run webui
# 构建或安装后也可运行 wish-webui
```

默认监听 `127.0.0.1:8790`。HTTP 接口如下：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/health` | 进程与 Agent 状态 |
| `GET` | `/api/runtime-recovery` | 查询当前 durable recovery 投影 |
| `POST` | `/api/runtime-recovery/reconciliations` | 持久化一项 Tool 人工核对结论 |
| `GET/POST` | `/api/sessions` | 列出或创建 Session |
| `GET/PATCH` | `/api/sessions/:sessionId` | 读取或修改标题 |
| `GET` | `/api/model-reasoning/default` | 不创建 Session，读取当前默认模型可选思考强度 |
| `POST` | `/api/sessions/:sessionId/archive` | archive Session |
| `GET` | `/api/sessions/:sessionId/history` | 读取规范 transcript |
| `GET/POST` | `/api/sessions/:sessionId/model-reasoning` | 读取或设置下一个新 Run 的思考强度 |
| `GET/POST` | `/api/sessions/:sessionId/runs` | 查询或启动 Run |
| `GET` | `/api/runs/:runId` | 查询进程内 Run 投影 |
| `POST` | `/api/runs/:runId/controls` | 提交 steer、follow-up 或 abort |
| `GET` | `/api/runs/:runId/events` | OutputEvent SSE |
| `GET` | `/api/approvals?runId=...` | 查询 pending approval |
| `POST` | `/api/approvals/:approvalId` | 决策 approval，可传 `scope` |
| `GET` | `/api/approval-rules` | 查看当前 retained allow rules |
| `DELETE` | `/api/approval-rules/:id` | 撤销一条 retained rule |

变更请求必须使用 `Content-Type: application/json`。启动 Run 返回 `202`；HTTP 请求或 SSE
断开只停止观察，不取消 Run。SSE `id` 使用 Runtime sequence，重连通过 `Last-Event-ID`
或 `after` 继续；缓存过期会返回明确的 `event_cursor_expired`。

页面从 `src/apps/webui/client/` 和 `public/` 构建，提供规范历史、活动 Run 输出、
显式 steer/follow-up/abort 和四种有效期的 Tool approval。HTML 不含内联脚本或样式，
Server 设置 CSP、`nosniff` 与 no-referrer；模型正文以安全纯文本显示，不自动加载远程内容。
`/api/health.runtimeRecovery` 暴露启动恢复快照；CLI 可报告被封口的 Run 与待人工核对的
Run ID，并通过 Application 的窄 Recovery Port 管理结论，不直接写 Journal 或重放 Tool。

### 独立管理面

`npm run webui` 和 `wish-webui` 固定启动 React + Browser Cordis 外壳，不需要版本开关。
`/` 与 `/index.html` 指向同一界面，没有旧版回退。Root 拥有监听器、静态资源、管理 API、Settings
和进程信号；业务 WebUI 插件只注册业务 handler。业务插件停用后管理面仍可用，业务请求
返回 `business_unavailable`，不以隐藏前端代替 Host 停用。

导出的 `startWishWebUiServer` 是嵌入／测试用的业务 API listener，不提供页面和管理服务；
完整产品界面由 bin 装配独立 Root Host。无管理组合的 `bootstrap` 保留通用 Include/HMR
契约，但这不是第二套 WebUI 启动模式。产品 WebUI 由独立 Root 配置监听器接收部署更新，
与管理启停串行协调、保留用户偏好。默认 profile 的 WebUI 默认启用受控代码监听，
不必再设置 `CORDIS_HMR=1`；`CORDIS_HMR=0 npm run webui` 可显式关闭。仅明确声明的
Step-local 所有者允许替换，持久化回执成功后才继续下一 Step，失败走独立管理恢复入口。
管理 API/SSE 同步 `codeReload` 状态；这不等于浏览器加载了新版 UI 代码。
目前不支持运行时更换监听端口或任意状态所有者热替换。
配置更新的在线范围及失败恢复见 [受控配置](../boot/plugin-control/README.md#配置文件重载)。
Root 监听端口由 `WISH_WEBUI_PORT` 指定，默认 8790；业务插件行的端口不重配置 Root。

管理文件根为 `WISH_MANAGEMENT_DATA_DIR`，否则为 `<WISH_DATA_DIR 或 ~/.wish>/management`。
`settings.json`、`credentials.json` 与 `plugins.json` 独立于业务 Storage；三者分别保存模块
设置、只写凭据和启停偏好／待核对意图／回执。凭据文件为 0600，启动环境值优先且从网页只读。
部署 YAML 与 `!!js` 表达式不由网页改写。当前 Settings 先注册立即生效的 `webui-appearance`
（主题 `light`／`dark`、界面语言 `zh-CN`／`en-US`、字号 `standard`／`large`／`extra-large`），
再注册消息输入的 `busy-delivery`：`queue` 表示下一轮，`steer` 表示下一 Step，
不打断当前 Tool。模块自行声明
字段、校验、生效时间；不是把所有插件配置自动暴露给浏览器。Models 只在安全描述中发布
模型、窗口和凭据引用；密钥值只经 Credentials 写入口，任何 GET、状态或事件都不会返回。

| 方法 | 管理路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/management/bootstrap` | 当前 Root 身份、CSRF token、业务可用性 |
| `GET` | `/api/management/plugins` | 部署 gate、用户偏好、实际运行状态、可写状态 |
| `POST` | `/api/management/plugins/preview` | 查询显式条目的影响及实际所有者报告 |
| `POST` | `/api/management/plugins/change` | 带 requestId、Root 身份与配置 revision 的受控启停 |
| `POST` | `/api/management/plugins/recover-disabled` | 重启后确认保持隔离停用，不重放操作 |
| `GET` | `/api/management/settings` | 已注册的安全设置描述及值 |
| `POST` | `/api/management/settings/replace` | CAS 替换单个命名空间的用户覆盖 |
| `POST` | `/api/management/credentials/describe` | 批量读取引用的脱敏状态与来源 |
| `POST` | `/api/management/credentials/set` | 只写一个受管凭据；回执不含原值 |
| `POST` | `/api/management/credentials/delete` | 删除受管值；不能删除启动环境值 |
| `GET` | `/api/management/events` | 状态失效通知；重连重新读取，不承诺持久事件重放 |

管理模式只绑定 `127.0.0.1`，须使用启动输出的同源地址。严格检查 Host、Origin、Fetch Site；
所有非 GET/HEAD 请求（包括业务 API）要求 `X-Wish-Management-Token`。不提供 CORS、远程
认证、TLS、任意 RPC、YAML 编辑或代码热重载。普通 JSON 写入有 256 KiB 上限。

模型、按版本加载及界面代码更新边界见 [Browser Client](webui/client/README.md)。
业务 UI 修改后可单独运行 `npm run build:webui-client`，不重写 Host 插件；浏览器在 core
版本兼容时局部替换模块，保留会话选择和草稿；共享运行库或全局 CSS 更新需保存草稿后刷新。
Plan、Skills、Memory、Tasks、
Workflow 与观察模块分别在自己的 `consumers/webui` 注册视图；Host 能力失效会卸载相关
Browser 插件，历史仍使用通用 Tool renderer。模块停用可能因未完成工作或缺少安全清理
协议被拒绝；这不是“所有插件随时可强制关闭”的开关。

当前业务页提供有版本凭证的状态阅读和已有人工操作，不是完整的 Skill 编辑器、Memory
知识库管理器或 Workflow 可视化编排器。Subagent/tmux 是所属记录及有界终端快照，不是
网页交互终端；attach 命令供本机终端接入。Context 只展示实际请求投影摘要，不收集正文
或伪造未知预算。规范聊天历史可重读；执行轨迹是有界进程内窗口，重启不能重建完整轨迹。
草稿按当前浏览器中的会话保留，切换面板不丢失；刷新/关闭标签页不承诺恢复未提交草稿。
会话名右侧三点菜单提供重命名、归档和删除；双击名称或按 F2 可直接行内重命名，
Enter 保存、Escape 取消。普通列表只显示活动会话；最左侧全局导航提供与“执行工作区”
同级的“归档”入口，不放在会话/业务视图列表中。活动与归档会话分别按完整 `Session.scope`
工作区路径分组，可折叠，同名目录不合并；归档会话可取消归档。删除只需一次确认，不要求先归档。
进入归档时，侧栏只列归档会话，主区显示选中的归档聊天；活动/归档分别保留浏览选择。
最左侧工具栏固定，会话侧栏可收起并通过 W 展开（悬停/键盘焦点切换展开图标）。界面不设
顶部横栏，区域标题和收起按钮位于侧栏内；连接状态以 W 右下角蓝/红点及可访问文字表达。
Host 复用所有权检查，并将 Run 接纳与归档/删除串行化；活动 Run 完成前、Runtime 待核对
或模块 `beforeRemoval` 拒绝时返回 `session_busy`。子 Agent 和 Workflow 在自己的 Consumer
提供检查，Apps 不解释它们的状态。已注册的检查所有者卸载后不能当作空闲；从未装配的
模块不在检查覆盖范围内，部署时应保留有关模块的检查入口。
删除只清理 Session 元数据、聊天历史与 checkpoint，不联动删除项目文件、Memory、任务、
Workflow、Runtime 日志、Tool Result 归档或 tmux 进程。持久层保留不可复用 ID 的空标记。
模型选择、审批规则撤销和 Runtime 副作用人工核对的专用页面尚未接入；对应业务 API 保留。
模型可通过 `WISH_MODEL` 等现有配置选择，Runtime 核对
可通过 CLI `wish recovery` 完成；删除旧页面不删除会话、规则或恢复记录。

## 安全与持久化限制

- Tool approval 不是 Sandbox；审批前的 SandboxPolicy 和执行时的 Filesystem/Shell 才是
  强制边界。当前没有认证、TLS 或公网部署边界，WebUI 应保持 loopback。
- 默认 `session-file` Provider 只保证单进程并发安全；CLI 与 WebUI 不能同时写同一 data directory。
- tmux child 使用独立 Session 与 Storage data root。父子只通过私有 task/result exchange
  文件和 tmux terminal 交互，不能共用上述单进程 store。
- Runtime event stream 和 Run 查询都是有界的进程内投影，不是持久 Event Store。
- Runtime lifecycle Journal 会在 Provider 激活前识别并封口中断 Run/Tool；损坏时产品图
  fail closed。reconciliation resolution 只核销人工待办并保留历史结论，不改写原 Tool 终态。
  当前没有进程内 Run 重建、自动重试或续跑；已 dispatch Tool 的未知副作用不能自动重放。
- WebUI 当前没有认证；reconciliation 的 `actor` 是审计标签而非已验证身份，所以管理 API
  与其他 WebUI API 一样只能置于可信 loopback 边界。
- Provider 请求前 Token 计数不可用时必须保持 `unknown`，Apps 不得伪造预算。

## 验证

```bash
npm run typecheck
npm run test:application-service
npm run test:app-plugin-config
npm run test:apps-composition
npm run test:apps-cli
npm run test:apps-webui
npm run test:run-generation
npm run test:subagent-child
npm run test:webui-next
# 另需安装 Playwright Chromium 及操作系统运行库；使用临时数据和本地模拟 Provider
npm run test:webui-next:browser
```

这些测试覆盖本地构建、进程内组合以及 HTTP/SSE 链路；真实 Provider、浏览器人工视觉、
跨进程恢复和公网部署需要分别验证。
