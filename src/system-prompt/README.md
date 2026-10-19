# System Prompt

`system-prompt` 是进程内的提示词段注册表。业务模块注册自己拥有的段。每个 Step
使用最终的 `availableTools` 快照完成选择：稳定段按顺序保留独立所有权，并在请求边界把
相邻同权威段合并后进入 `ModelRequest.instructions`；动态段由 Context consumer 投影为
`ContextItem`。

## 所有权

- `consumers/base.ts` 只注册与具体能力无关的 Wish 身份、权威边界、Coding Agent
  行为、通用 Tool 调用规则和输出风格。
- 部署级和 Agent 级附加指令由 `Agents` 配置拥有，排在基础稳定段之后；没有配置时
  不再复制一份默认身份。
- 完整 Tool 目录、description 和参数约束由结构化 Tool schema 提供；这里不生成工具
  目录，只在跨调用 guidance 中点名必要的 Tool。
- 需要跨多次调用才能表达的能力规则由能力模块自己注册。例如 filesystem、shell、
  web、subagents、Plan、Goal、Todo、Coordinator、Tasks、Workflow 和 Memory 分别拥有
  自己的 guidance，并通过 `requiredTools` 绑定最终可见能力。入口引导说明何时选择
  能力及其跨工具边界；工具参数和完整状态仍由各自的 Tool schema 与 Context Provider 提供。
- Mode、Plan、Coordinator、权限、Sandbox、Workspace、Memory 和 Skills 等变化事实仍由
  各自的 Context Provider 投影；本模块不复制这些状态。

## 顺序

1. `order` 从小到大；
2. `order` 相同时按 `id` 排序；
3. `stable_prefix` 进入独立的模型 instructions 通道；相邻同权威段以两个换行连接，
   不改变注册表中的 section 身份；
4. 首次调用时 `dynamic_tail` 放在当前用户消息之前；已有 Tool Call/Result 的续轮中，
   它放在完整 Tool Call/Result 配对之后。

默认 authority 是 `developer`。无工具依赖的段默认放在 `stable_prefix`；声明了
`requiredTools` 的段只有在当轮所有工具都可用时才会出现，并且必须放在
`dynamic_tail`。这保证权限或模式过滤工具后，过期的工具指导不会继续发给模型，
同时避免工具变化使稳定前缀失效。

注册与调用方 Cordis Fiber 同生命周期。模块只保存进程内贡献，不拥有 Session
持久化，也不复制工具 schema。工具的名称、description 和 input schema 仍由
AgentLoop 从最终工具快照传给 Model Provider。

## 历史快照与 WebUI

提示词注册表本身仍是进程内能力；`history/provider.ts` 另以 Storage Journal 保存
`status=ready` 的最终请求快照。它不写入 Session transcript，也不改变 Context 的脱敏
观察记录。快照包含实际的 `ModelRequest.instructions`，以及已被最终 Context 投影接纳的
本模块 `dynamic_tail` 段；Tool schema、普通历史和其他 Context Provider 的正文不混入其中。

`consumers/history.ts` 是 Context 通用投影观察端口的可拔插消费者；
`consumers/webui-control.ts` 只提供只读查询。浏览器模块通过 WebUI 的通用 ledger slot
贡献默认折叠的“系统提示词”与“系统提示词更新”行。相同 digest 不按 Step 重复显示；
历史正文按请求时快照读取，不用当前注册表重建。展示时只合并相邻且 channel、role 相同的
区块，避免重复标题，不改变持久化的模块贡献边界。关闭浏览器模块不影响捕获，关闭 WebUI
adapter 不影响 CLI 或模型请求，关闭历史 consumer 也不影响提示词组装。

默认产品图的稳定段顺序为：

```text
wish.identity
→ wish.authority
→ wish.behavior
→ wish.tool-use
→ wish.output
→ deployment / Agent additions
```

这五个 Wish 基础段都使用 `system` authority，因此组装后形成一条稳定 instruction；
同为 `system` 的部署级或 Agent 级附加指令会在最终请求边界继续与它合并。WebUI 历史展示
实际发送的合并结果，注册表仍保留各段 id 供插件生命周期、选择和确定性排序使用。

Tool guidance 不进入这个稳定前缀。它在每个 Step 根据最终 `availableTools` 选择后，
通过 `dynamic_tail` 靠近当前工作状态发送。
