# Models

`src/models/` 是 Wish Core `Model` Port 的外部实现。它负责配置、模型路由、协议
转换、usage、价格和 Catalog；Core 继续拥有重试、流聚合、Context、Tools、
AgentLoop 与 Run/UserTurn/Step 生命周期。

## 结构与依赖

```text
Cordis Models service
  ← OpenAI Chat Completions Adapter plugin
  ← OpenAI Responses Adapter plugin
  ← Anthropic Messages Adapter plugin
  → Models configuration
  → ConfiguredModel
  → UsageResolvingModel
  → core/model.RetryingModel
  → core/agent-loop.AgentLoop
```

- `types.ts`：公开的 Provider、Model、兼容性、价格和 Adapter DTO。
- `provider-definitions.ts`：稳定的协议、endpoint、鉴权环境变量和请求兼容定义。
- `models.generated.ts`：由公开模型源生成并随 Wish 提交的模型元数据，不包含凭据。
- `defaults.ts`：组合固定 Provider 定义与生成模型，形成默认配置。
- `config.ts`：JSON/环境配置加载、启动期校验、完整模型引用解析和覆盖合并。
- `registry.ts`：协议到 Adapter factory 的显式注册表。
- `runtime.ts`：严格按 `ModelRequest.model` 路由，并在调用时解析 headers/凭据。
- `service.ts`：G6.2 Cordis wrapper，拥有配置来源、Registry、usage estimator 和每个
  AgentLoop 与 Application 使用的请求资源组合。
- `plugins.ts`：三个协议 Adapter 的独立 Loader 插件；每项注册都绑定调用插件 fiber。
- `providers/`：OpenAI Responses、OpenAI Chat Completions-compatible 与
  Anthropic Messages 转换。
- `usage.ts`：按完整模型身份注册 tokenizer、补齐缺失 usage、计算费用。
- `input-tokens.ts`：按完整模型身份注册 request-only tokenizer，为 Context 提供调用
  前的输入 Token 计数。
- `providers/anthropic-messages-tokens.ts`：调用 Anthropic Messages 官方计数端点，
  统计最终映射请求。
- `catalog.ts`：请求热路径外的 list/check/diff/sync 控制面服务。
- `storage/models/file-catalog-store.ts`：Catalog 的原子 JSON 文件 Store。

Provider 不发布 Runtime event、不执行 Tool、不聚合 `ModelOutput`，也不实现 retry
或 fallback。`ConfiguredModel` 同样不做 retry；`createConfiguredModelStack` 只按上图
固定顺序组合现有装饰器。

## 配置

没有提供 JSON 时，Wish 使用提交在仓库中的 generated defaults。当前快照从
models.dev、OpenRouter 和 Vercel AI Gateway 生成，只收录声明支持 Tool Call、且能由
Wish 当前 `openai-responses`、`openai-chat-completions` 或
`anthropic-messages` Adapter 表达的模型。固定
Provider 定义决定协议、endpoint 和鉴权；远端模型源只能提供模型名、能力、窗口和价格
元数据，不能覆盖凭据或传输行为。

当前 checked-in 快照包含 17 个 Provider、803 个模型，默认选择
`deepseek/deepseek-v4-flash`。模型源没有可靠提供的字段保持未知；OpenRouter 的分段价格
也不会压扁成一个失真的静态价格。generated 元数据不等于当前账号已经可以调用。

普通 `npm run build` 不访问网络。显式刷新和校验 generated 文件：

```bash
npm run models:generate
npm run models:check-generated
```

刷新同时请求三个必要来源；任何来源、schema 或必需默认模型失败时命令非零退出，并且不
覆盖已有文件。输出按 Provider/model 排序、去重，并通过 `ModelSpec` 类型约束；默认配置
加载时仍会经过同一公开配置解析器的严格校验。

凭据只写环境变量名，不能把 API key 写入公开 DTO。`schemaVersion: 1` 仍表示一份完整
替换配置：

```json
{
  "schemaVersion": 1,
  "defaultModel": "openai/gpt-example",
  "fallbackModels": ["anthropic/claude-example"],
  "maxRetries": 2,
  "providers": [
    {
      "id": "openai",
      "protocol": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "type": "bearer", "apiKeyEnv": "OPENAI_API_KEY" },
      "developerRoleMode": "native",
      "request": {
        "streamUsage": true,
        "supportsTemperature": true,
        "maxTokensField": "max_output_tokens",
        "extraBody": { "store": false }
      },
      "models": [
        {
          "id": "gpt-example",
          "status": "active",
          "input": { "text": true, "image": true },
          "reasoning": true,
          "toolCalling": true,
          "developerRole": true
        }
      ]
    },
    {
      "id": "anthropic",
      "protocol": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "auth": { "type": "x-api-key", "apiKeyEnv": "ANTHROPIC_API_KEY" },
      "developerRoleMode": "system-fallback",
      "models": [{ "id": "claude-example" }]
    }
  ]
}
```

`schemaVersion: 2` 表示在 generated defaults 上叠加用户配置。Provider 和 Model 按
`id` upsert；`headers`、`request.extraBody`、`input` 和 `price` 做字段级合并。例如：

```json
{
  "schemaVersion": 2,
  "defaultModel": "deepseek/deepseek-v4-pro",
  "providers": [
    {
      "id": "deepseek",
      "baseUrl": "https://proxy.example.com/v1",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "maxOutputTokens": 65536
        }
      ]
    },
    {
      "id": "local",
      "protocol": "openai-chat-completions",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "auth": { "type": "none" },
      "developerRoleMode": "system-fallback",
      "models": [{ "id": "qwen-local", "toolCalling": true }]
    }
  ]
}
```

`loadModelsConfigurationFile` 从显式 `path` 或 `WISH_MODELS_CONFIG` 读取文件；
`loadModelsConfiguration` 也可直接接收已解析值、JSON 字符串或
`WISH_MODELS_JSON`，三者都没有时回退到 generated defaults。这些环境入口仍是 Models
模块的独立 API；Wish 的生产启动链不会让它们在 Host 深处隐式生效。

生产启动由 `cordis.yml` 的 `models` Config 显式选择 JSON/路径；默认 profile 只在 Loader
边界把兼容的 `WISH_MODELS_CONFIG` / `WISH_MODELS_JSON` 映射过去。Host 在没有显式
JSON/路径时读取 `<dataDirectory>/models.json`，默认位置是 `~/.wish/models.json`；文件
不存在才使用 generated defaults。旧的 `schemaVersion: 1` 文件继续完整替换；新的
`schemaVersion: 2` 文件使用上述 overlay 语义。
`WISH_MODEL`、`WISH_FALLBACK_MODELS` 和
`WISH_MODEL_MAX_RETRIES` 同样由默认 profile 映射为 `models` Config 的初始进程选择；外部
profile 直接配置 `model`、`fallbackModels` 和 `maxRetries`。CLI `--models-config` 仍作为
本次 surface 的最高优先级覆盖交给 Models service。

模型选择顺序由组合根保持：显式 Run/Agent 模型 → `ConfiguredModel` 当前进程
默认值 → 文件 `defaultModel` → 第一个 Provider `defaultModel`。每次模型请求仍必须
携带完整 `provider/model`；`ConfiguredModel` 不会用可变默认值覆盖请求。AgentLoop
会在首个 Step 固定主模型，所以运行中的 UserTurn 不受后续默认值切换影响。

Provider 默认配置先应用，Model 的 endpoint/auth/headers/developer role/request
配置随后覆盖。`extraBody` 不能设置 `model`、`messages`、`tools`、`system`、
`stream`、token limit 等关键字段。重复 Provider/Model、未知协议、无效 URL、
auth、developer authority、价格和引用都会在加载阶段失败。

## 协议

生产 profile 把以下三种协议作为三个独立插件注册到 `ctx.models`：

- `openai-responses`：OpenAI 原生 input items、developer authority、图片、reasoning
  summary、增量函数调用、Responses SSE 和 usage；默认请求不由 Provider 保存。
- `openai-chat-completions`：system/developer/user/assistant/tool、图片、reasoning、
  增量 Tool Call、SSE、stream usage 和两种 max-token 字段。
- `anthropic-messages`：独立 system、显式 developer system-fallback、图片、thinking、
  tool_use 增量 JSON、cache read/create usage 和 Messages SSE。

新协议插件注入 `models`，再调用 `ctx.models.register(protocol, factory)`；注册 effect
属于调用插件 fiber，所以 stable-id disable、reload、Models service 消失和 Root dispose
都会撤销对应协议，恢复后可以重新注册。`createDefaultModelAdapterRegistry()` 只保留给
非 Cordis 的独立组合与现有模块测试。协议仍不依据模型名或 URL 推断；AbortSignal 会
传给真实 `fetch`，Provider response 不进入 Core DTO。

`Models.open()` 创建 `ConfiguredModel → UsageResolvingModel → RetryingModel` 和配套
`ModelRequestTokenCounter`，然后把完整请求依赖交给 AgentLoop service；Application
只得到模型选择所需的 `configuredModel` view。`ApplicationFacade` 不创建
Registry、estimator、模型请求栈或 request counter。
Provider 凭据仍在每次调用时从 `launch.environment` 的原引用读取，配置 DTO 不保存密钥。
`RetryingModel` 继续是纯 Core 对象，没有继承 Cordis Service。

## Usage 与费用

Provider usage 优先。完成事件没有 usage 时，`UsageResolvingModel` 查找实际完成
`provider/model` 对应的 `ModelTokenizer`；没有注册 tokenizer 或 estimator 失败时，
保留 usage 缺失，不伪造 token。Tokenizer 接收最终 Core `ModelRequest` 和聚合视图，
因此实现必须计算消息、Tool schema、Tool Call、图片、reasoning 与正文。

`calculateModelCost` 使用实际完成模型的 price version/currency，分别计算 uncached
input、cache read、cache write 和 output。缓存 usage 或对应价格未知时返回
`status: "unavailable"`，但不影响模型结果。Models 不负责 Run/UserTurn 归因、跨
Step 指标持久化或 UI 展示。

## 请求前输入 Token

`ModelRequestTokenCounter` 与 usage estimator 分离：它只接收最终 `ModelRequest`，不
伪造尚未发生的 `ModelOutput`。每个 tokenizer 按完整 `provider/model` 注册，并负责
统计 messages、reasoning、Tool Call 参数、Tool schema、图片和协议开销。

计数前会复制并冻结请求快照。没有注册精确 tokenizer，或 tokenizer 发生普通不可用
错误时返回 `undefined`，让 Context 报告 `unknown`；非法负数或非整数属于实现契约
错误。AbortSignal 会传给 tokenizer，中止原因继续向上传播。

`createConfiguredModelRequestTokenCounter()` 从同一份 Models configuration 为每个
`anthropic-messages` 模型注册服务端精确计数器。它复用正常请求映射并调用
`POST /messages/count_tokens`，因此 system、messages、Tool schema、Tool Call 和图片
都按 Provider 输入统计；凭据和动态 header 每次计数时重新解析。HTTP/响应不可用时不
猜测，仍返回 `undefined`。

OpenAI Responses 与 Chat Completions 当前没有注册“精确”本地计数器。其消息与 Tool
开销会随模型和协议实现变化；在没有经过版本固定和校准的算法前，Context 保持
`unknown`，不能把字符数或通用 tokenizer 估算标记为预算事实。未来可以按精确
`provider/model` 另行注册经过验证的 `ModelRequestTokenizer`。

模型窗口由 `ConfiguredModel.getContextWindowTokens()` 从已经加载、校验的
`ModelSpec` 读取。控制面的 `ModelCatalog` 不进入每次请求的 Budget 热路径。

## Catalog

`ModelCatalog.list/check/diff` 不写 Store；只有 `sync` 写入。文件 Store 使用同目录
临时文件和 rename 原子替换。Provider 同步互相隔离，失败项保留 last-known-good。
被配置或发现的模型仍标记为 `unverified`，callability 为 `unknown`；存在于 Catalog
不证明当前凭据、Tool、图片、reasoning、价格或窗口信息真实可用。

## 验证

```bash
npm run typecheck
npm run test:cordis-models
npm run test:model-generation
npm run test:models-runtime
npm run test:model-providers
npm run test:model-usage
npm run test:model-input-tokens
npm run test:model-composition
npm run test:model-catalog
npm test
```

Provider 测试使用本地 fixture 和注入的 `fetch`。只有另行加载真实凭据并执行在线
检查后，才能声称某个账号或模型实际可调用。
