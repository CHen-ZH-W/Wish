# System Prompt

`system-prompt` 是进程内的提示词段注册表。业务模块注册自己拥有的段。每个 Step
使用最终的 `availableTools` 快照完成选择：稳定段进入 `ModelRequest.instructions`，
动态段由 Context consumer 投影为 `ContextItem`。

## 所有权

- `consumers/base.ts` 只注册与具体能力无关的 Wish 身份、权威边界、Coding Agent
  行为、通用 Tool 调用规则和输出风格。
- 部署级和 Agent 级附加指令由 `Agents` 配置拥有，排在基础稳定段之后；没有配置时
  不再复制一份默认身份。
- Tool 名称、description 和参数约束只进入结构化 Tool schema，不在这里生成工具
  目录。
- 需要跨多次调用才能表达的能力规则由能力模块自己注册。例如 filesystem、shell、
  web 和 subagents 分别拥有自己的 guidance，并通过 `requiredTools` 绑定最终可见能力。
- Mode、Plan、Coordinator、权限、Sandbox、Workspace、Memory 和 Skills 等变化事实仍由
  各自的 Context Provider 投影；本模块不复制这些状态。

## 顺序

1. `order` 从小到大；
2. `order` 相同时按 `id` 排序；
3. `stable_prefix` 进入独立的模型 instructions 通道；
4. 首次调用时 `dynamic_tail` 放在当前用户消息之前；已有 Tool Call/Result 的续轮中，
   它放在完整 Tool Call/Result 配对之后。

默认 authority 是 `developer`。无工具依赖的段默认放在 `stable_prefix`；声明了
`requiredTools` 的段只有在当轮所有工具都可用时才会出现，并且必须放在
`dynamic_tail`。这保证权限或模式过滤工具后，过期的工具指导不会继续发给模型，
同时避免工具变化使稳定前缀失效。

注册与调用方 Cordis Fiber 同生命周期。模块只保存进程内贡献，不拥有 Session
持久化，也不复制工具 schema。工具的名称、description 和 input schema 仍由
AgentLoop 从最终工具快照传给 Model Provider。

默认产品图的稳定段顺序为：

```text
wish.identity
→ wish.authority
→ wish.behavior
→ wish.tool-use
→ wish.output
→ deployment / Agent additions
```

Tool guidance 不进入这个稳定前缀。它在每个 Step 根据最终 `availableTools` 选择后，
通过 `dynamic_tail` 靠近当前工作状态发送。
