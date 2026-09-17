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
- `session-reasoning.ts`：Models 拥有的 Session 级思考强度选择，借用 Storage Domain
  持久化；不把选择写入通用 Settings 或 Browser Conversation 状态。
- `service.ts`：Cordis wrapper，拥有配置来源、Registry、usage estimator 和每个
  AgentLoop 与 Application 使用的请求资源组合，并在 WebUI surface 向 Settings 注册默认
  模型选择、逐模型上下文窗口和单次请求最大输出覆盖。
- `consumers/webui/index.tsx`：Models 自己拥有的模型配置面板；Host Models 条目失效时，
  Browser Cordis 同步撤销该入口；同一 Browser 插件向已有会话和新建会话输入框分别贡献可卸载的思考强度控件。
- `plugins.ts`：三个协议 Adapter 的独立 Loader 插件；每项注册都绑定调用插件 fiber。
- `providers/`：OpenAI Responses、OpenAI Chat Completions-compatible 与
  Anthropic Messages 转换。
- `usage.ts`：按完整模型身份注册 tokenizer、补齐缺失 usage、计算费用。
- `input-tokens.ts`：按完整模型身份注册 request-only tokenizer，为 Context 提供调用
  前的输入 Token 计数。
- `providers/anthropic-messages-tokens.ts`：调用 Anthropic Messages 官方计数端点，
  统计最终映射请求。
- `catalog.ts`：请求热路径外的 list/check/diff/sync 控制面服务。
- `catalog-persistence.ts`：可替换的 Catalog 持久化 Service Definition。
- `persistence/domain-store.ts`：基于 Storage Domain 的 Catalog Store。
- `persistence/storage-provider.ts`：把 Catalog Store 接到所选 Storage Backend 的
  Cordis Provider。
- `persistence/file-store.ts`：保留的原子 JSON 文件兼容 Store。

Provider 不发布 Runtime event、不执行 Tool、不聚合 `ModelOutput`，也不实现 retry
或 fallback。`ConfiguredModel` 同样不做 retry；`createConfiguredModelStack` 只按上图
固定顺序组合现有装饰器。

## 配置

没有提供 JSON 时，Wish 使用提交在仓库中的 generated defaults。当前快照从
models.dev、OpenRouter 和 Vercel AI Gateway 生成；DeepSeek 直连 Provider 使用经官方文档
核对的定义覆盖第三方目录的滞后数据。其余模型只收录声明支持 Tool Call、且能由
Wish 当前 `openai-responses`、`openai-chat-completions` 或
`anthropic-messages` Adapter 表达的模型。固定
Provider 定义决定协议、endpoint 和鉴权；远端模型源只能提供模型名、能力、窗口和价格
元数据，不能覆盖凭据或传输行为。

当前默认选择 `deepseek/deepseek-flash`。旧 `deepseek-v4-flash` 与
`deepseek-v4-flash-vision-exp` 保留为已退役兼容名；已保存的旧选择在实际使用时指向新版
Flash，不静默改写原设置。DeepSeek 的峰谷价格和 OpenRouter 的分段价格都不会压扁成
失真的静态价格，因此价格未知。generated 元数据不等于当前账号已经可以调用。

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
          "maxOutputTokens": 65536,
          "defaultMaxOutputTokens": 16384
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

`maxOutputTokens` 是模型目录的能力上限，不会直接发送到请求中。
`defaultMaxOutputTokens` 是可选的逐模型请求默认值。WebUI 模型配置中的
“单次请求最大输出”覆盖按完整模型引用单独保存，优先于该默认值；清空覆盖后恢复默认值。
如果两者都没有，OpenAI-compatible/Responses 请求省略相应字段，交由模型服务决定；
Anthropic Messages 因协议需要显式 `max_tokens`，使用不超过目录能力上限的协议兜底值。
显式 Run 请求参数优先于 WebUI 覆盖，任何显式值均不能超过已知模型上限。

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

WebUI 的“模型配置”从这份已验证配置生成完整 `provider/model` 选项。默认模型选择在
下一次新 Run 开始时采样；上下文窗口与单次请求最大输出覆盖在下一次请求时读取，不修改
已经发出的请求。它不改变 fallback、retry、Provider endpoint 或凭据，也不把 Catalog
元数据当作账号可调用证明。配置更新移除旧选择时，设置保留该值供用户修复，实际新 Run
回退到当前部署默认值。

会话输入区仅对显式声明 `reasoningControl` 且协议适配器可表达的模型显示思考强度。
当前默认 DeepSeek 模型提供“关闭／低／高／极高”；下拉框直接选中模型请求配置的默认强度，
不额外列出“默认”项，也不把目录最大能力当作请求默认值。选回默认强度会清除 Session 覆盖，
继续继承模型配置。选择按 Session 和模型引用持久保存，切换默认模型后
旧选择不会误应用到新模型。新 Run 启动时把强度固定进输入；运行中的 Step、steer 与
同一 Run 的后续 UserTurn 不受选择变化影响。WebUI 的
`GET/POST /api/sessions/:id/model-reasoning` 只读写这一 Models 能力；并发写入以
Storage revision 冲突拒绝。停用 Models Browser 插件会撤销输入区控件，不影响已保存的选择。
新建会话界面通过 `GET /api/model-reasoning/default` 读取默认模型能力，不因此创建 Session。
用户选择先留在 Browser；首次发送创建 Session 后，通过同一 Models 接口持久化所选强度，
成功后才启动首个 Run。默认选项不写入覆盖；选项冲突或写入失败时不以错误强度发送首条消息。

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

OpenAI-compatible SSE 的中间 chunk 可以携带 `usage: null`；它按缺失 usage 处理，只有
实际 usage 对象才会更新最终完成事件的统计。

新协议插件注入 `models`，再调用 `ctx.models.register(protocol, factory)`；注册 effect
属于调用插件 fiber，所以 stable-id disable、reload、Models service 消失和 Root dispose
都会撤销对应协议，恢复后可以重新注册。`createDefaultModelAdapterRegistry()` 只保留给
非 Cordis 的独立组合与现有模块测试。协议仍不依据模型名或 URL 推断；AbortSignal 会
传给真实 `fetch`，Provider response 不进入 Core DTO。

`Models.open()` 创建 `ConfiguredModel → UsageResolvingModel → RetryingModel` 和配套
`ModelRequestTokenCounter`，然后把完整请求依赖交给 AgentLoop service；Application
只得到模型选择所需的 `configuredModel` view。`ApplicationFacade` 不创建
Registry、estimator、模型请求栈或 request counter。
Provider 凭据在每次调用时按原引用解析：显式请求环境、启动环境或独立 Credentials Provider；
启动环境优先，配置 DTO、Settings DTO 和模型 Browser Client Model 都不保存或读回密钥。
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
`ModelSpec` 读取。WebUI 可以按完整 `provider/model` 保存 1K–10M 的用户覆盖；Context 在下一次
请求预算时动态读取，留空则继续使用模型目录值。覆盖不改写公开 Models 配置，也不会改变已经
冻结的 Step。控制面的 `ModelCatalog` 不进入每次请求的 Budget 热路径。

## Catalog

Catalog 的持久化边界仍是 `ModelCatalogStore`。除原有 `FileCatalogStore` 外，Storage 模块
提供 `DomainModelCatalogStore`，将相同 Port 映射到 `models/catalog` Domain；Catalog 本身
不依赖 Storage Hub、KV 或文件 Provider，也不会静默迁移旧 catalog 文件。
默认 `model-catalog-storage` Cordis Provider 把这个 Store 绑定到选中的
`storageBackend`。Provider 生命周期只负责装配；canonical Catalog 状态仍属于 Domain/Store，
不会放进 Cordis Context。

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
npm run test:model-reasoning
npm run test:model-usage
npm run test:model-input-tokens
npm run test:model-composition
npm run test:model-catalog
npm test
```

Provider 测试使用本地 fixture 和注入的 `fetch`。`test:model-composition` 还覆盖
DeepSeek 思考模式下 Tool 调用、完整 `reasoning_content` 回传、下一次请求和流式 usage；
严格模拟服务端在遗漏回传时返回 400。只有另行加载真实凭据并执行在线检查后，才能
声称某个账号或模型实际可调用。
