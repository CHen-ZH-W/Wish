# Models

`src/models/` 是 Wish Core `Model` Port 的外部实现。它负责配置、模型路由、协议
转换、usage、价格和 Catalog；Core 继续拥有重试、流聚合、Context、Tools、
AgentLoop 与 Run/UserTurn/Step 生命周期。

## 结构与依赖

```text
Models configuration
  → ConfiguredModel
  → UsageResolvingModel
  → core/model.RetryingModel
  → core/agent-loop.AgentLoop
  → core/runtime.Runtime
  → core/agent.Agent
```

- `types.ts`：公开的 Provider、Model、兼容性、价格和 Adapter DTO。
- `config.ts`：JSON/环境配置加载、启动期校验、完整模型引用解析和覆盖合并。
- `registry.ts`：协议到 Adapter factory 的显式注册表。
- `runtime.ts`：严格按 `ModelRequest.model` 路由，并在调用时解析 headers/凭据。
- `providers/`：OpenAI Chat Completions-compatible 与 Anthropic Messages 转换。
- `usage.ts`：按完整模型身份注册 tokenizer、补齐缺失 usage、计算费用。
- `input-tokens.ts`：按完整模型身份注册 request-only tokenizer，为 Context 提供调用
  前的输入 Token 计数。
- `catalog.ts`：请求热路径外的 list/check/diff/sync 控制面服务。
- `storage/models/file-catalog-store.ts`：Catalog 的原子 JSON 文件 Store。

Provider 不发布 Runtime event、不执行 Tool、不聚合 `ModelOutput`，也不实现 retry
或 fallback。`ConfiguredModel` 同样不做 retry；`createConfiguredModelStack` 只按上图
固定顺序组合现有装饰器。

## 配置

配置版本固定为 `schemaVersion: 1`。凭据只写环境变量名，不能把 API key 写入公开
DTO：

```json
{
  "schemaVersion": 1,
  "defaultModel": "openai/gpt-example",
  "fallbackModels": ["anthropic/claude-example"],
  "maxRetries": 2,
  "providers": [
    {
      "id": "openai",
      "protocol": "openai-chat-completions",
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "type": "bearer", "apiKeyEnv": "OPENAI_API_KEY" },
      "developerRoleMode": "native",
      "request": {
        "streamUsage": true,
        "supportsTemperature": true,
        "maxTokensField": "max_completion_tokens",
        "extraBody": {}
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

`loadModelsConfigurationFile` 从显式 `path` 或 `WISH_MODELS_CONFIG` 读取文件；
`loadModelsConfiguration` 也可直接接收已解析值、JSON 字符串或
`WISH_MODELS_JSON`。`WISH_MODEL`、`WISH_FALLBACK_MODELS` 和
`WISH_MODEL_MAX_RETRIES` 可以覆盖文件的初始进程选择。

模型选择顺序由组合根保持：显式 Run/Agent 模型 → `ConfiguredModel` 当前进程
默认值 → 文件 `defaultModel` → 第一个 Provider `defaultModel`。每次模型请求仍必须
携带完整 `provider/model`；`ConfiguredModel` 不会用可变默认值覆盖请求。AgentLoop
会在首个 Step 固定主模型，所以运行中的 UserTurn 不受后续默认值切换影响。

Provider 默认配置先应用，Model 的 endpoint/auth/headers/developer role/request
配置随后覆盖。`extraBody` 不能设置 `model`、`messages`、`tools`、`system`、
`stream`、token limit 等关键字段。重复 Provider/Model、未知协议、无效 URL、
auth、developer authority、价格和引用都会在加载阶段失败。

## 协议

`createDefaultModelAdapterRegistry()` 注册：

- `openai-chat-completions`：system/developer/user/assistant/tool、图片、reasoning、
  增量 Tool Call、SSE、stream usage 和两种 max-token 字段。
- `anthropic-messages`：独立 system、显式 developer system-fallback、图片、thinking、
  tool_use 增量 JSON、cache read/create usage 和 Messages SSE。

新协议通过 `ModelAdapterRegistry.register(protocol, factory)` 增加，不依据模型名或
URL 推断协议。AbortSignal 会传给真实 `fetch`；Provider response 不进入 Core DTO。

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
