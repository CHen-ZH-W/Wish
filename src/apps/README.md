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
Cordis Models service -> ConfiguredModel / request stack
Cordis ContextEngine + Compaction services
Cordis Tools service <- Basic Tool plugins
Cordis AgentLoop service -> StepPipeline
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
算法、Context 投影、摘要、Session 事务、Tool 执行或 Runtime 状态机。CLI/WebUI 只注入
`launch` 与 `application`，不得通过深层 import 绕过模块公共出口。

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
- `WISH_MODELS_CONFIG`、`WISH_MODELS_JSON`、`WISH_MODEL`、
  `WISH_FALLBACK_MODELS`、`WISH_MODEL_MAX_RETRIES`；
- `WISH_CONTEXT_RESERVED_OUTPUT_TOKENS`；
- `WISH_COMPACTION_KEEP_RECENT_TOKENS`、
  `WISH_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS`；
- `WISH_MAX_STEPS`、`WISH_RUN_GENERATION_DRAIN_TIMEOUT_MS`；
- `WISH_WEBUI_HOST`、`WISH_WEBUI_PORT`、`WISH_WEBUI_WORKSPACE_ROOT`。

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
- `WishWorkspaceResolver` 按 Session 为每个 Step 解析新的 `cwd` 与 workspace instructions。
- Context、Tool Result archive、Compaction、input renderer 和 transcript pipeline 必须解析到
  同一个 `sessionId`。

Sessions 是 CLI 与 WebUI 唯一的持久对话事实源。Runtime delta 只用于活动 Run 的临时展示；
Run 终态后界面重新读取规范 transcript，不维护第二份 conversation/message store。

## 输入与控制

`WishRunPayload` 只包含普通文本和可选模型。模型只在新 Run 开始时选择并固定；follow-up
沿用同一模型，不能在运行中切换。

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
```

- `wish` 只在 TTY 中进入逐行交互模式；`wish run` 是显式 one-shot。
- one-shot 没有 prompt 参数时才读取 piped stdin。
- `--cwd` 只用于新 Session，不能与 `--session` 同时使用。
- 新 Session 用首条输入生成最多 60 个 Unicode 字符的确定性标题，不调用模型。
- 活动 Run 中普通输入和 `/steer` 都映射为 `steer`；`/follow-up` 创建新 UserTurn；
  `/abort` 取消 Run。
- `/exit` 和 `/quit` 不能绕过活动 Runtime；应先 abort。
- 非 TTY Tool approval 会 fail closed；TTY 的 `y/yes` 只批准当前调用一次。
- 模型正文写 stdout；提示、reasoning、Tool 生命周期与错误写 stderr。
- 第一次 `SIGINT` 请求 Runtime abort；终态前再次收到信号或等待超过 5 秒才强制退出。

## WebUI

```bash
DEEPSEEK_API_KEY=... npm run webui
WISH_MODELS_CONFIG=./models.json npm run webui
# 构建或安装后也可运行 wish-webui
```

默认监听 `127.0.0.1:8790`。HTTP 接口如下：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/health` | 进程与 Agent 状态 |
| `GET/POST` | `/api/sessions` | 列出或创建 Session |
| `GET/PATCH` | `/api/sessions/:sessionId` | 读取或修改标题 |
| `POST` | `/api/sessions/:sessionId/archive` | archive Session |
| `GET` | `/api/sessions/:sessionId/history` | 读取规范 transcript |
| `GET/POST` | `/api/sessions/:sessionId/runs` | 查询或启动 Run |
| `GET` | `/api/runs/:runId` | 查询进程内 Run 投影 |
| `POST` | `/api/runs/:runId/controls` | 提交 steer、follow-up 或 abort |
| `GET` | `/api/runs/:runId/events` | OutputEvent SSE |
| `GET` | `/api/approvals?runId=...` | 查询 pending approval |
| `POST` | `/api/approvals/:approvalId` | 决策一次性 approval |

变更请求必须使用 `Content-Type: application/json`。启动 Run 返回 `202`；HTTP 请求或 SSE
断开只停止观察，不取消 Run。SSE `id` 使用 Runtime sequence，重连通过 `Last-Event-ID`
或 `after` 继续；缓存过期会返回明确的 `event_cursor_expired`。

浏览器页面直接从 `src/apps/webui/public/` 构建，无前端框架。它提供 Session 管理、规范历史、
活动 Run 输出、显式 steer/follow-up/abort 和一次性 Tool approval。HTML 不含内联脚本或
样式，Server 设置 CSP、`nosniff` 与 no-referrer；Markdown 只渲染转义后的安全子集，
不自动加载远程图片。

## 安全与持久化限制

- Tool approval 不是 Sandbox；当前没有认证、TLS 或公网部署边界，WebUI 应保持 loopback。
- `FileSessionStore` 只保证单进程并发安全；CLI 与 WebUI 不能同时写同一 data directory。
- Runtime event stream 和 Run 查询都是有界的进程内投影，不是持久 Event Store。
- 当前没有 Runtime/Tool 中断恢复；已 dispatch Tool 的未知副作用不能自动重放。
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
```

这些测试覆盖本地构建、进程内组合以及 HTTP/SSE 链路；真实 Provider、浏览器人工视觉、
跨进程恢复和公网部署需要分别验证。
