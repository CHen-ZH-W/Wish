# Subagents

`src/subagents` 管理子 Agent 身份、父级归属、并发限制、持久化记录、执行状态核对和完成事件。
具体 App 和终端实现通过独立适配器接入。

```text
CLI launcher adapter ─> optional SubagentLauncher ─┐
                                                   ├─> Subagents Runtime ─> Subagents Service
tmux adapter ────────> SubagentExecution Service ──┤          │
Storage Backend ───────────────────────────────────┘          └─> lifecycle events
```

## 契约

- `SubagentRuntime` 是领域的具体实现，负责记录状态转换、全局及每个父级的数量限制、
  状态核对监测和事件发布。两种并发限制默认都是 8；持久化记录总数没有准入上限。
- `SubagentsRuntimeService` 持有 Storage 租约，并依赖选定的 `SubagentExecution` Provider。
  只有创建子 Agent 或访问结果时才解析 `SubagentLauncher`；没有 Launcher 时，
  已有记录和 list/capture/send/stop/collect 仍可用，新建请求会被拒绝。
- `SubagentExecutionTarget` 是与具体 Provider 无关的可序列化目标。
  它始终暴露可观察的目标和可复制的连接/画面截取命令；Provider 专用的重建信息保存在不透明的 `locator` 中。
- `providers/tmux-execution.ts` 只负责执行适配。父子 Agent ID、限制、记录和结果文件不进入 `src/tmux`。
- `apps/cli/subagent-launcher.ts` 管理 Wish CLI 参数、私有任务/配置交换文件及子进程环境。
  启动前检查系统 CLI 开关，并将父 Host 的部署文件与插件策略目录传给子进程。子进程
  只读同一策略，私有数据根不隔离停用决定；目标插件被停用时，受影响子进程停止并清理，
  管理端确认清理后才返回成功。策略处于变更或恢复状态时，新启动会被拒绝。
  领域代码只依赖 `SubagentLauncher` 契约。
- 每次读取或控制请求都携带父 Agent、Session、Run 和 Workspace 身份。
  Runtime 校验四项身份，对不属于调用方的子 Agent 返回未找到；模型工具无需重复实现该策略。
- 结构化子 Agent 结果通过 Launcher Service 读取。终端输出只供用户诊断，不解析为执行结果。
- Runtime 监测正在运行的执行并发出 `subagent.updated`。
  Runtime continuation 适配器订阅这些事件，不维护另一套轮询。
- 关闭或替换领域服务会保留独立托管的终端。终止子 Agent 执行必须显式调用 `stop`。
- 所属 Run 结束或 Session 被删除时，Session Feature 调用 `purge`：停止子执行目标、
  移除子 Agent 交换文件和数据文件，并删除持久化记录。
  如果启动结果尚未确定且没有记录目标，会阻止清理，直到结果得到确认。
- Host 的 `idempotencyKey` 请求派生稳定的子 Agent 地址，并在检查容量前返回已有的匹配记录。
  任务、归属或权限冲突会被拒绝；丢失或失败的记录不会在同一个键下被静默重新启动。
  Workflow 管理 Attempt 与子 Agent 的绑定，并利用该地址恢复派发/绑定之间的崩溃中断。
- 稳定的工具 Consumer 通过可选策略端口派发。Workflow 可以接入持久化调度，
  无需注册另一套工具；移除适配器后直接使用 Subagents 派发，无需替换 Consumer。
  其他 Host 调用方继续直接使用 Subagents。

## 生命周期与配置

领域的 `lifecycleSnapshot(signal)` 读取已存储的记录计数，不刷新进程状态、不更新记录，也不启动监测器。
它报告待完成的串行操作、监测器、记录中的运行子 Agent 和结果未确定的记录。
这些是记录层面的观察，不能证明每个外部进程都仍在运行或已经停止。
即使没有记录执行目标，失败的启动仍然保持结果未确定；缺少目标不能证明启动没有产生副作用。
可选的 Host 生命周期查询还跟踪所有正在进行的公开请求，并将未收尾工作报告为 `drain`。
查询注册归属于对应服务 Fiber，卸载时撤销；查询不会调用 `stop`，也不改变已有 `close` 契约。
计数不包含父子身份、任务文本、locator 或工作区路径。

停止守卫同步关闭服务准入，包括旧引用和订阅；暂停新的监测工作，等待已接纳的 API 和记录操作完成，
然后复用服务的关闭 Promise 和租约释放逻辑。
运行中及结果未确定的记录继续持久化；管理停用不会调用执行 `stop`、杀死独立托管的终端，
或将不确定的启动视为已确认。新的 Runtime 会核对这些相同的记录。

所有可能刷新记录的操作（`list`、`inspect`、`capture`、`send`、`collect`、`resume`）
与创建、停止和监测核对共用 Runtime 的修改队列。较晚完成的检查不能覆盖更新的显式停止结果。
Session/生命周期观察保持只读，不将自身计入执行工作，但其读取会在 Storage 释放前完成。
`close()` 同步拒绝新工作、移除监听器、停止监测准入，并为所有调用方返回同一个排空 Promise。
已接纳操作会在记录存储和 Provider 租约关闭前完成；旧服务引用不能获得后继实例的权限。
关闭不会取消已经接纳的显式停止，也不会把结果未知的启动解释为可以安全重试。

重新激活会读取原有持久化记录并核对保存的执行目标，不通过再次调用 spawn 重建已有子 Agent。
观察能力启动失败会使依赖它的调度器保持不可用，同时保留记录和独立托管的窗格。
Runtime 和 tmux 执行适配器声明参与代码重载：Step 和上游调度器排空后，Runtime 封闭准入，
等待已有监测读取完成，不中止命令。新实例核对保存的目标。
Workflow 管理的父级关联在此替换期间保留；独立模型 Consumer 的旧结果转交器尚不支持重载，
存在时会阻止变更批次。受控停用继续等待运行中或未确定记录的在途操作完成，
不会停止或重新启动其执行。
`npm run test:stateful-code-reload:real` 覆盖真实父 Run、子进程 PID 和 Attempt 的连续性，
以及激活和回执失败。

`WISH_SUBAGENTS_ENABLED=0` 卸载 tmux 执行适配器、CLI 启动器和领域 Runtime，
不关闭 tmux 本身。`WISH_SUBAGENT_TOOLS_ENABLED=0` 独立移除面向模型的 Consumer。

CLI 子 Agent 在 `<parent-data>/subagents/children/<id-hash>/` 下使用独立的数据目录和 Storage 根目录。
子模式禁用递归 Subagents；权限配置和工具上限继承父级或被显式收紧。
Host 显式提供的能力上限也会传入子进程环境。显式为空的工具/能力范围会拒绝执行，
不会退回无限制的默认值。
`WISH_AGENT_PRESETS_JSON` 选择可选的角色专用工具、Prompt、Compaction 和 Memory 组合；
解析后的工具列表在启动前提交，预设 digest 保存在子 Agent 记录中。
契约和示例见 `src/composition/README.md`。

模型凭据通过独立的一次性交接传递。启动器只解析所选子模型及已配置回退模型需要的 API key 引用，
将值写入绑定子 Agent 身份、权限为 `0600` 的封装文件，并且只传递其路径。
子 Agent 在打开 Application 前读取并删除该文件，之后仅通过代际范围内的 Models 解析器使用凭据。
凭据值不会进入创建请求、argv、tmux 元数据、持久化 Subagent 记录、任务文本或输出。
子进程启动环境中对应的环境变量会被显式清空；缺少引用时在执行前失败。
这会缩小应用层泄露范围，但不能隔离使用同一操作系统账号运行的其他进程。

领域 Runtime 没有对 CLI 启动器的静态依赖。Sessions 或启动器适配器不可用时，
新的 `spawn` 请求会被拒绝，而持久化记录读取及基于执行后端的 list/capture/send/stop/collect 仍可用。
重新接入启动器即可恢复创建准入，无需替换 Subagents Runtime。

## Host 资源交换

`SubagentLauncherService.registerResourceProvider()` 接受可选的 Host 资源贡献，
注册跟随 Consumer 的 Cordis 生命周期。模型工具不能选择资源文件、根目录或 Provider。
资源是有大小限制的 JSON 封装，包含类型、schema 版本、完整父子身份和 digest；
资源本身不会执行代码或授予权限。

CLI 启动器在子 Agent 私有的 `resources/input.json` 下写入不可变输入清单。
启动执行前，Runtime 将 `resourceManifestDigest` 提交到持久化子记录。
Consumer 在接受输出前比对这份 Host 绑定；子 Agent 不能通过重写输入文件并重新计算哈希来改变范围。
资源文件有大小限制、拒绝符号链接穿越，并使用固定的派生地址。
输出资源在 `resources/output/<resource-type>.json` 下独立原子提交，并绑定确切的输入 digest。

`WISH_CHILD_RESOURCES_FILE` 和 `WISH_CHILD_RESOURCES_DIGEST` 是启动器管理的启动事实。
启动器同时固定 `WISH_CHILD_ID`、`WISH_CHILD_SESSION_ID`、`WISH_CHILD_RUN_ID`
和 `WISH_CHILD_EXCHANGE_DATA_DIR`；显式为空的资源设置阻止继承祖先附件。
Session 和 Storage 目录保持隔离。该协议不能在使用同一账号运行的互不信任进程之间建立操作系统隔离。

Memory 是本模块之外的可选资源 Consumer，交付共享记忆库的只读位置和授权范围，不复制记忆内容。
子进程每次读取父库的最新已提交内容，不能写入或启动独立整理。
子任务结果仍通过 Runtime 回到父会话，供父级记忆学习使用；完整子会话不会被这个资源 Consumer 自动导入。
共享资源文件或 tmux 都不会把 File Storage 的进程内写入保证提升为多进程安全。

## 验证

```bash
npm run test:subagents
npm run test:subagent-tools
npm run test:subagent-child
npm run test:subagent:real
npm run test:subagent:runtime-real
npm run test:state-handoff
npm run test:state-handoff:real
node scripts/accept-subagent-resources.mjs
node scripts/accept-memory-child-resources.mjs
node scripts/accept-memory-child-real.mjs
```
