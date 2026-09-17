# Tools

`src/tools/` 只提供模型 Tool 的通用注册、授权适配、结果持久化和输出边界；它不拥有
Filesystem、Shell、Web、Subagent、Plan、Coordinator 或其他领域能力，也不拥有这些能力的模型 Consumer。

```text
领域 Tool Consumer
  → ctx.tools.register(ToolDefinition)
  → Tools service
  → Core ToolRegistry
  → Core ToolExecutor
  → Core BoundedToolScheduler
  → AgentLoop
```

Tool 是能力面向模型的一个可选入口。Provider 与模型 Consumer 分别依赖自己的领域
Service Definition，二者互不依赖；禁用 Tool 不会删除 Host 已加载的能力。

## 目录职责

```text
src/tools/
├── index.ts
├── service.ts
├── authorization.ts
├── presentation/
│   └── truncate.ts
└── results/
    ├── service.ts
    ├── types.ts
    ├── artifacts/
    └── providers/
```

- `service.ts`：Cordis `ctx.tools` 注册面。每次注册绑定调用方 Fiber，Consumer
  卸载时自动注销。
- `authorization.ts`：standalone Approval Port 到 Core Tool authorization 的兼容适配。
  CLI、WebUI 和持久批准规则不归 Tools 所有。
- `presentation/truncate.ts`：不同模型 Consumer 共用的有界文本呈现函数，不执行领域
  能力。
- `results/`：Tool Result Archive 与大输出 Artifact 的通用持久化 seam。
- `index.ts`：只导出上述通用设施，不重导出具体领域 Consumer。

Wish 每个 Step 使用 `WishToolExecutionContext`，其所有权在
`src/composition/tool-context.ts`。Core Tool Registry/Executor/Scheduler 保持泛型，不依赖
Wish 的 Workspace、Permissions、Models 或 Runtime 类型。

## Consumer 所有权

| 模型入口 | 代码所有者 | 底层能力 |
| --- | --- | --- |
| `read` / `write` / `edit` | `filesystem/consumers/model-tools` | Filesystem |
| `grep` | `filesystem/search/consumers` | Filesystem Search |
| `bash` | `shell/consumers` | Shell |
| `web_search` / `web_fetch` | `web/tools.ts` | Web Search / Fetch |
| `spawn_agent` 等 | `subagents/consumers/model-tools` | Subagents |
| `enter_plan_mode` 等 | `plan/consumers/model-tools` | Plan |
| `enter_coordinator_mode` 等 | `coordinator/consumers/model-tools` | Coordinator |

五个 Coding Tool 的 standalone 兼容组合位于 `src/composition/coding-tools.ts`；通用结果
renderer 位于 `src/tools/presentation/result-renderer.ts`。产品 Cordis 图仍逐个加载
Consumer，不通过组合函数隐式创建 Provider。

## 固定执行边界

- Core 在调用 `execute` 前完成输入解析、能力申请、审批、最终复核和一次性 Grant
  签发。
- 通用 Grant 契约与动态激活检查位于 `src/permissions/authorization.ts`；Tool Core 只负责绑定
  `kind: "tool"` 的 subject。
- Consumer 在真正调用领域 Service 前检查本次 Grant。
- Provider 在发生 IO 或进程副作用前再次核对 authority 与 Provider generation。
- Registry 变化只影响后续 Step；旧 Step 不能混用新旧 Tool 定义。
- 已 dispatch 且终态未知的副作用进入 reconciliation，不自动重放。
- Bash 始终同步；长期进程和交互任务通过 tmux 暴露。

## 使用入口

```ts
import { ToolRegistry } from "wish/core/tools";
import { Tools } from "wish/tools";
import {
  registerBasicTools,
  createBasicToolResultRenderer,
} from "wish/composition/coding-tools";
import type { WishToolExecutionContext } from "wish/composition/tool-context";

const registry = new ToolRegistry<WishToolExecutionContext>();
const registrations = registerBasicTools(registry, {
  // standalone 调用方显式注入各领域 Provider
});
const renderer = createBasicToolResultRenderer();
```

产品启动不调用 `registerBasicTools()`。Cordis 配置分别加载 Filesystem、Shell 等
Provider，以及对应能力目录内的模型 Consumer。

## 验证

```bash
npm run typecheck
npm run test:basic-tools-integration
npm run test:cordis-tools
npm run test:cordis-agent-loop
```
