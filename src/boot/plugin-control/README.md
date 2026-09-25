# Plugin control

此目录拥有进程插件管理的 Host 适配。公开 `PluginInspection` 与
`PluginLifecycleInspection` 只读端口，以及独立的 `PluginStopControl` 协调端口；
投影 Cordis 状态并向真实所有者采集资源条件，不拥有插件运行时、领域状态或配置副本。
`bootstrap()` 在 Root 安装它，通过 `BootstrappedProcess.plugins` 和
`ctx.pluginInspection` 提供给 Host Consumers。业务 Provider 停用不会一起撤销此端口；
Root 卸载后旧引用拒绝查询。

## 管理对象与状态协议

`management-types.ts` 定义管理层协议，不承载第二份 Loader 配置或任务状态。
`PluginSelection` 使用 `instanceId + entryIds[]` 明确操作对象；单个入口与整个功能
使用同一种选择方式。功能所属的 Provider、Context、Tool、人类入口应由装配／功能适配
显式列出，不能按模块名、Service 名或 Entry ID 前缀推导成员。没有 UI 的插件同样可选择。
这个列表不是批量原子事务保证；多个条目的执行、部分失败和持久化必须由执行层处理。

`previewPluginSelection(snapshot, selection)` 在同一份观测上校验全部条目、计算影响；
空列表、重复 ID、缺失条目和其他 Root 的选择均拒绝，不接受部分匹配。ID 在同一 Root
内也可能被删除后重建，因此 `instanceId` 仅拦截跨进程旧请求，不是版本锁。

三类状态独立表达，不用一个 `enabled` 枚举同时代表它们：

| 状态 | 协议与含义 |
| --- | --- |
| 配置状态 | `PluginConfigurationState`：用户选择 inherit / enabled / disabled；管理配置是未接管、已保存、未保存还是保存失败；保存版本单独记录 |
| 运行状态 | `PluginEntryView` / `PluginFiberView`：Loader gate、有效启用值、实际 Fiber phase；依赖等待不改写用户意图 |
| 操作状态 | `PluginOperationState`：检查、收尾、应用、核实、成功、拒绝、冲突或失败；失败单独报告运行态、配置和清理的已知结果 |

`enabled` 偏好不能越过部署约束、父级 gate、权限或沙箱边界，不能通过覆盖 `!!js` 条件
实现；`inherit` 撤销的是管理层选择，不是将部署配置强制设为启用。保存状态不能由
Loader 的有效 gate 推导，成功操作必须分别确认运行结果、真实清理完成和所请求的保存。
操作超时或响应丢失不能直接变成“未修改”的拒绝；发生变更后失败时保留未知／部分结果，
供执行层核对，不宣称自动回滚了副作用。

管理类型由 `ManagedPluginStore` 和 `ManagedPluginControl` 在显式 managed 装配中实现；
普通 bootstrap 仍不请求持久化。Root 检查结果不从有效 gate 推导“已保存”。

## 查询

`inspect()` 返回冻结、可 JSON 序列化的当前观测：

- `instanceId` 标识本次 Root，重新 bootstrap 后改变。Entry ID 和 Fiber ID 不能跨实例使用。
- `managementClass` 来自 Host Catalog 或经过校验的外部 manifest，而非浏览器、Entry ID、
  模块名规则或运行时注册状态：`kernel` 是必须保留管理路径的进程基础设施，`structural` 是
  组合载体，两者可见但只读；Catalog 外部 Entry 必须通过 `management.manifest` 引用 v1 静态规范，
  只写 `class: managed` 仍是黄色只读的 `noncompliant`，绝不能自动冒充 Kernel。归为 `managed`
  只表示静态准入完成；活动 Fiber 仍须提供完整 Owner 协议。
- 外部 Entry 的浏览器视图只带 API 版本、插件 ID、替换模式、能力种类、隔离模式和状态版本；
  不返回本地 manifest 路径、Config Schema、配置值或权限资源。
- Entry 使用 Loader 的完整 ID，包含所属 Include 的前缀；Group 父子关系单独记录，
  不通过模块名、ID 前缀或字符串拆分猜测。
- `gate` 区分未声明、显式启用、显式停用和条件表达式；`enabled` 使用 Loader 的有效值，
  条件求值失败时为 `null`。不返回配置、条件表达式正文或原始错误。
- `phase` 来自实际 Fiber 状态。Consumer 可以 `enabled: true` 且 `phase: pending`，
  表示等待依赖，不代表用户关闭了 Consumer。
- Cordis Group carrier 即使自身 gate 为 disabled 也可以保持 active；该 gate 作用于后代。
- `absent` 仅表示 Entry 当前没有 Fiber。Loader 可能在异步清理结束前就撤下 Fiber，
  也会移除创建失败后回滚的 Entry；查询不把缺席解释为清理成功或构造失败历史。
- Fibers 包括 Loader 管理之外的 Root 基础设施和内部 injection fibers。
  `entryRoot` 区分整个 Entry 的实例与它内部的可选依赖分支。

只通过公开的 `Fiber.store` 读取已经捕获的 Service 绑定，不比较 Service 名称或值来匹配
Provider。两个 isolate realm 使用同名 Service 不会被合并为一条依赖；没有捕获的绑定
标记为 `unobserved`，不推断其 Provider。

## 停用影响预览

`previewDisable(entryId)` 在一次新观测上计算：目标的运行实例／Group 后代、受其所有权
影响的子 Fiber，以及已绑定这些 Fiber 所提供 Service 的依赖链。每个受影响 Fiber
包含一条可解释的到达路径。内部 injection 分支失效不等于整个父插件停用。

预览不调用 Loader update、dispose，不保存配置，也不批准启停。返回值固定声明
`coverage: observed-fibers`、`safety: not-assessed`，不能用作授权或并发更新凭证。

以下内容不属于这份观测的保证：

- 没有显式 inject 的动态调用、普通对象引用、外部进程和业务任务的依赖。
- pending／未加载插件未来会注册的能力，以及没有捕获的依赖绑定。
- 活动 Run、Workflow、Storage lease 的安全停止或恢复判断。
- 持久化配置是否写入成功、已经执行的副作用是否完成或可回滚。
- 原子配置快照、插件事件历史、审批、HTTP/SSE、Browser 同步和启停执行。

因此基础设施与普通插件都可查询，不按名称设立不可关闭清单；实际操作必须另外检查
模块自己的收尾条件、配置约束、依赖影响和管理入口恢复路径。缺失安全基础设施时不得
允许相关执行退化为无保护运行。

## 停用条件评估

`assessPluginDisable(snapshot, selection, evidence?)` 是 Host 可复用的纯评估函数。
它不注册插件、不操作 Loader、不读写配置、不发送 abort、不释放 Lease，也不提供授权。
单独传入现有检查快照会返回 `blocked`，不会将尚未接入管理的模块默认为安全。

Host 适配需要提供三项明确前提：配置是否有受控管理路径、管理恢复入口是否保留，以及
相关准入／安全边界是否继续受到保护。`admission: guarded` 是对既有 generation、Grant
和模块准入检查的确认，不是新增一套权限。信息未知时一律阻止当前操作。

生命周期报告由 Host 向对应所有者采集，不允许客户端自行提交。Evidence 必须携带采集时
使用的同一份 inspection snapshot 对象；即使 Fiber ID 未变，不同观测之间也不能意外
复用报告。对象身份校验不锁定业务状态，也不替代执行时的并发检查。覆盖范围分别是：

- 每个被直接修改 gate 的 Entry，以及 Group／Include 的配置后代，包括没有 Fiber 的条目。
- 每个实际受影响的 Fiber，包括依赖退出的 Consumer 和内部 injection 分支。

Entry 报告回答当前条目的管理与隐藏收尾条件，Fiber 报告回答该运行实例的资源条件；前者
不能替代后者。嵌套分支失效不等于整个模块退出。缺失、重复、范围外或格式错误的报告
均阻止操作；结果只保留限定 subject 字段和公开诊断 code，不复制额外数据或原始错误。

| 评估结果 | 含义 |
| --- | --- |
| `direct` | 所有已声明条件允许进入受控停用，仍须等待真实 disposer 完成 |
| `drain` | 所有者要求先收尾；具体等待、取消或拒绝策略由所有者定义，不代表允许强杀 |
| `blocked` | 条件缺失、不安全、已在切换或当前拒绝；刷新／补齐条件后重新评估 |
| `maintenance` | 配置只读或管理恢复依赖维护路径，不能执行普通在线停用 |
| `restart` | 恢复路径要求重启；不是当前进程强制卸载的授权 |

多个条件全部保留，摘要按 `blocked > restart > maintenance > drain > direct` 排序。
已观测到的 loading／unloading 和 gate 求值失败不会被一个“空闲”报告豁免。
返回值始终标记 `safety: requires-execution-check`：它只说明这次 Host 报告的结论，
不包含完整业务依赖证明、配置版本锁或任务状态锁。执行前必须在准入边界内重新采集、
检查版本与所有者身份，再由对应模块收尾，不能重放旧评估来授权操作。

语义验收使用四类样例：普通空闲能力和纯后端插件在明确前提下返回 `direct`；带活动 Run
的模块根据所有者约定返回 `blocked` 或 `drain`；Storage 有 Lease 时要求收尾，恢复入口
不能在线保留时要求维护或重启。测试使用真实 Loader、RunGeneration、StorageHub 和临时
File Backend；语义测试中的手工 Evidence 不是生产启停授权。

## 所有者绑定与真实报告采集

`bootstrap()` 在业务树加载前安装 Root-owned `PluginOwnerRegistry` 与 `PluginChangeCoordinator`；
生命周期查询与代码更新不再各自保存一套 Owner 声明。每个 Fiber generation 在同一记录中同时表达状态、停用 guard
和 `drain | generation` 替换方式；记录任一部分变化都会产生新的 registration ID，并使并发
观察失效。`PluginLifecycleRegistry` 与 `CodeReloadCoordinator` 只保留兼容适配/读取职责。

完整 Owner 通过 `registerPluginOwner(ctx, registration)` 一次登记：`status(signal)` 只读报告，
`prepare(change)` 同步封锁准入并返回 `drained/deactivate/release`，`replacement` 声明 drain 或
generation。`PluginWorkOwner` 在声明代码可替换时使用这条单次注册路径。旧生命周期与代码更新
API 仍可为非 managed 的独立兼容场景合并同一 Fiber 记录，但该记录明确标为
`compatibility`；managed stop、配置更新和原生 HMR 都在执行副作用前拒绝它。重复 lifecycle、
重复 replacement 或 restart/online 冲突会在不改变原记录的情况下拒绝。restart 和拆分声明
都只是兼容债务，不会被解释为 managed conformance。

Loader Group 会并发提交兄弟条目的配置更新，而 Provider 更新又可能通过 required service
传播到 Consumer。Registry 因此按进程内 Fiber UID 串行受管 Fiber 的 `internal/update`；
如果一个更新排到队首时该 Fiber 仍在 loading/unloading，先等待当前代稳定，再执行本次
restart 并等待完成。这样避免 `old epoch -> inactive -> old epoch` 的 ABA 吞掉新配置；
短暂卸载期间仍保留该 UID 的受管身份。真正重复的 lifecycle/replacement 声明仍然拒绝，
不会用“覆盖旧注册”掩盖重入。

`bootstrap()` 通过
`BootstrappedProcess.pluginLifecycle.collect(selection)` 暴露只读采集。
进程内 `ctx.pluginLifecycle` 还允许注册查询，外部读端口没有注册或启停方法；不得把
进程内 registry 的任意调用暴露为 HTTP/RPC。业务子树卸载不会撤销 Root 采集入口，
但这不等于独立 HTTP 管理入口已经实现。

非 managed 的旧模块可在自己的 Cordis 装配边界调用 `registerPluginLifecycle(ctx, query)`，不增加必需的
`inject`，独立运行且没有 registry 时不安装观察器。查询归提供的 Context/Fiber 所有，
不能用一个名称注册任意 Entry ID；跨 Root、重复所有者和已失活 Fiber 拒绝注册。
每个 Fiber 注册一个聚合查询，资源的状态与聚合规则由模块自己维护，中央没有模块名分支。
注册者负责覆盖该 Fiber 自己的资源；一个内部 injection Fiber 的报告不代表整个父模块。

注册通过同一个所有者的 `ctx.effect` 撤销，并保留精确 Fiber/Entry 对象身份和本次
`registrationId`。依赖恢复可能复用 Fiber ID，但会产生新的注册代次。查询在调用前和
返回时都检查所有者仍有效；采集期间的配置更新、注册变化或可见依赖树变化会使结果变成
`lifecycle_observation_changed`。没有 Fiber 的条目不会复用旧报告来证明清理完成。

查询默认限时 1000 ms，安装选项允许 1–30000 ms。每次查询收到独立 AbortSignal；超时、
所有者撤销和 Root 关闭时发出取消。查询实现须配合取消，不能在查询中发起调度、刷新记录、
改变准入或执行写操作。超时／异常／格式错误返回稳定的阻止原因；晚到的结果和拒绝被消费
并丢弃，不延长卸载等待。JavaScript 同步阻塞代码无法被这个异步 deadline 抢占，插件仍是
受信任本地代码，不是隔离沙箱。
同一注册所有者最多运行一个查询；即使超时，忽略取消的查询在真正结束前仍占用该观察槽，
再次轮询只返回 `lifecycle_query_pending`，不会不断追加挂起查询。

采集结果包含这一次 observation、对应 Entry/Fiber 的报告，以及具体注册所有者的
`status`。状态只允许 disposition、公开 code 和至多 16 个非负安全整数计数，所有额外字段
丢弃；不返回任务正文、路径、Run 身份或原始异常。输出是冻结的 JSON 数据快照，不缓存
上次成功结果作为当前报告。

当前生产装配提供的观察：

| 所有者 | 实际来源与停用条件 |
| --- | --- |
| Runtime Provider | 已创建 RunGeneration 的活动 Run、退休中代次数量；忙碌时返回 drain，先封新 Run，再由 generation retirement 收尾或中断受影响 Run |
| File Storage Provider | 该 Backend registration 的真实 lease 数与关闭状态；lease 未释放返回 drain，退休或关闭失败返回 blocked |
| Workflow Scheduler | 请求、排队 tick、等待中的父 Run、持久 Workflow/Attempt，以及尚未创建 Workflow 的 graph start；忙碌时返回 drain，排空调度调用后由新 Fiber 接管持久状态和外部 child |
| Subagents Runtime Provider | 在途请求、串行操作、监视器和持久 live/未核对记录计数；只读 Store，不调用会更新记录的 list/inspect，不探测或停止进程 |

未接入的插件、停用／pending 条目和没有完整所有者报告的分支继续返回
`lifecycle_unassessed`。`coverage: registered-owners` 只表明实际覆盖的查询者，不声称列出了
所有业务依赖。整个采集也不是原子的业务状态快照：任务可以在异步查询期间继续运行。

真实资源报告不等于管理操作可执行。受控配置、恢复入口和执行准入尚未在执行层确认，
因此采集 Evidence 的 `configuration`、`recovery`、`admission` 仍为 `unknown`；直接交给
`assessPluginDisable` 会阻止操作。读查询不会推导这三项前提，也不能替代执行前的版本与
准入检查。受控停用使用下面的独立执行协议，不复用客户端提供的 Evidence。

## 受控停用执行

`installPluginStopControl(root, inspection, { host, timeoutMs })` 安装 Root 协调器。
公开端口只有 `disable(selection)` 与 `current()`，后者只读取最近一次被接纳操作的冻结
回执，不触发轮询业务、清理或重试。`bootstrap()` 暴露 `pluginStops`；未安装
受控配置／恢复适配器的普通启动进程返回 `stop_host_unavailable`，不改写 profile。
显式 managed 装配使用下述适配器；UI 是否接入与这些 Host 协议独立验证。

managed 模块必须在装配边界使用一次 `registerPluginOwner()`，或使用内部调用该入口的
`PluginWorkOwner`。`prepare(change)` 必须同步封住该代所有新准入（包括已经返回的旧引用），
不取消已有工作；若抛错必须保持原样。返回 guard 的 `release()` 只撤销尚未提交的准入限制，
必须幂等、不抛错；`deactivate()` 则复用模块真正的幂等资源清理 Promise，不能只撤销查询注册
或隐藏 UI。缺少 canonical Owner、只有兼容拆分声明或没有 stop guard 的任何受影响 managed
所有者都会使整个操作拒绝，不按模块名补充默认清理逻辑。

执行顺序是：

1. 捕获显式选择、采集当前所有者，并取得受信任 Host 配置／恢复 reservation。
2. 检查所有受影响所有者均支持协议，按实际所有权／绑定关系确定 Consumer／子级优先的顺序；依赖环拒绝。
3. 逐个同步封住所有者准入、重查条件并等待真实收尾，然后才封住下一个所有者。Consumer 收尾期间仍可调用尚未关闭的 Provider。
4. 每个异步边界重查注册代次、配置 reservation 与运行树；模块清理全部成功后才调用 Host apply。
5. 等待 apply、Host verify，再独立确认 gate 已关闭且旧影响 Fiber 不再运行，才报告成功。

支持当前 active 的普通插件条目，也支持配置上已启用、但因缺少依赖而稳定处于
`pending`/`failed` 且没有 inertia/effects 的普通条目。后一种条目没有活动 Owner 可排空，
Host 会锁定同一份运行图观测后直接关闭 gate；若依赖恢复导致 Fiber 开始激活，操作按观测冲突
拒绝。带预激活资源的 pending/failed 条目继续拒绝直接落闸；实现必须先消除这类资源，不能借
未激活状态绕过 Owner 清理协议。
停用后的条目可以重新启用；依赖仍缺失时结果是 `enabled: true + phase: pending`，不是启用失败。
Group carrier、缺席或未覆盖的 active 分支继续拒绝。批量操作不是原子事务。模块状态仍归各自
所有者，管理层只协调 guard，不复制 Run、Workflow、child 或 lease 状态，也不新增后台 Bash 管理。

| 模块 | 准入与真实清理 |
| --- | --- |
| Runtime | 同时封住 `open()` 与已返回 RunGeneration 的 `startRun()`；已接纳 generation 在停用／换代时 retire，允许受影响 Run 完成收尾或以明确 abort 终态结束，旧引用随后拒绝 |
| File Storage | 封住 Hub 获取及子 lease 派生；已有 lease 完成已接纳工作并由原所有者释放，随后 unregister 等待物理 close；旧 facet 随物理关闭失效，不删除数据 |
| Workflow Scheduler | 先封住并排空 graph start，再封住 submit/retry/cancel/watch 和新 timer/event tick；已有调度调用完成后关闭两类 scheduler，父等待、持久 Run/Attempt 和外部 child 留给新 Fiber 核对，不取消或重放 |
| Subagents | 封住服务请求与订阅并排空在途请求、监视器与串行记录操作；live/未核对记录保持持久，关闭旧记录服务并释放 lease，不终止独立进程或重复 spawn |

`PluginStopHost.reserve()` 是进程内受信任适配接口，不是客户端填写的安全标记。它必须
排斥并发配置写入、保留独立恢复入口、校验实际 Entry/配置代次；apply 须保留部署约束、
等待 Loader 清理。所有清理均已确认后，若 Host apply 或最终核验确定失败，可用保留的配置
重建旧代并再次核验；清理未完成、超时或状态未知时绝不反向启用。本协议不请求持久化，成功明确返回
`persistence: not-requested`。不能直接拿 Include 的 `entry.update({ disabled: true })`
充当适配器：它可能覆盖条件表达式或间接写回部署文件。

协调器同一时刻只执行一个操作。默认总 deadline 30000 ms（可设 1–30000 ms）只限制
等待响应，不强杀资源。清理前拒绝可释放准入限制；清理异常、超时或完成状态未知时保留
准入限制与配置 reservation，标记部分／未知结果，并拒绝后续操作为
`stop_recovery_required`。全部清理已确认但 Host apply／核验确定失败时，才允许从 retained
配置重建并验证旧代。晚到 Promise 的拒绝被消费，但不会继续下一步、重放 apply 或
升级为成功。`current()` 保留 deadline 当时的结果；`cleanup: pending` 不代表后来仍未完成，
也不自动证明后来已经完成，须显式核对后恢复。当前没有在线修复／恢复命令。

`accept-plugin-stop` 单独验证真实 Cordis、模块收尾和测试 reservation；生产受控配置及 HTTP
链路通过下面的 managed 验收另行验证，不把 mock reservation 当作生产持久化证明。

## 受控配置与恢复

`ManagedPluginControl`、`ManagedProfile` 与 `ManagedPluginStore` 是显式 managed 装配：

- 部署 YAML 由操作员维护，管理 API 从不回写；用户偏好单独保存为 enabled/disabled，
  inherit 删除该项覆盖。普通 Entry 的 enabled 不能越过当前接受部署版本的 disabled 或条件
  表达式；只有部署文件明确声明“用户激活委托”时，才可覆盖该 Entry 的默认关闭 gate，且
  仍不能越过委托中保留的硬约束。API 只改变已识别普通 Entry 的偏好，不写 Group、子 Include、
  Root 基础设施或任意插件配置。
- Kernel 与结构项继续出现在管理清单和检查结果中，但 UI 以灰色只读状态显示；Host 对绕过 UI
  的变更请求同样返回 `management_target_read_only`，不能靠客户端禁用按钮保护管理基础设施。
- 请求包含 Root instanceId、revision、显式 Entry IDs 和幂等 requestId。Host 先把 operation 持久化
  为 queued，再执行副作用；同 requestId/指纹返回已有 operation，冲突请求拒绝。顶层变更按 FIFO
  串行，轮到执行时重新检查 revision。业务修改仍先持久化 pending 意图，才封准入和执行资源收尾；
  成功或清理前拒绝再提交回执。最后 100 个回执与 256 个 operation 有界保留。
- 部分清理、apply 或持久化结果不确定时保留 pending 与已加的限制，状态为
  recovery-required。不能通过自动重试或反向启用恢复未知副作用。
- 重启时 pending 的目标 gate 被隔离关闭；Root 管理入口可核对并显式确认保持停用。
  同一故障进程不能直接清除该状态。恢复不删除领域数据、不重新执行 Tool，也不重放 enable。
- `plugins.json.lock` 与 Settings lock 使用进程身份和 nonce 排斥第二个文件写者；关闭不移除
  其他所有者的替换锁。Plugins 锁只在 Linux 上确认 host/boot/PID namespace
  一致且原 PID 已不存在时回收；回收操作本身有独立排他锁。活 PID（含复用）、旧格式、
  外部命名空间、损坏锁或遗留 `.recover` 锁继续拒绝，需操作员核对。Settings 的锁策略
  未改变。回收锁不清除 pending，不替代显式隔离恢复；SIGKILL 测试确认不会重放副作用。
- Stop 等待有总 deadline；启用遵循插件自己的初始化生命周期。浏览器等待超时不意味着
  Host 操作被取消，仍须查看 working/pending 状态，不能盲目重发。忽略退出的插件可能需要
  运维在确认状态后结束进程；这里没有强杀和假成功。

### 用户激活委托

默认策略仍是 fail closed：未声明管理元数据的 Entry 只能停用或恢复部署默认值，不能用
`enabled` 偏好覆盖部署表达式。需要允许 WebUI 打开的默认关闭能力，由部署 profile 在该
普通 Entry 上显式声明：

```yaml
management:
  manifest: ./example.wish-plugin.json # Catalog 外部条目必需
  activation: user
  constraint: !!js launch.environment.EXAMPLE_ENABLED === '0'
```

Catalog 内建条目由 Host 元数据分类，不需要 manifest；外部条目不能靠 `class: managed` 自我提升。
`activation: user` 只把该
Entry 的默认关闭 gate 交给用户；`constraint` 是单独的硬阻止条件，
求值为 true、求值失败或所需部署事实不可用时均不允许启用。它不适用于 Group，也不授予
配置字段、权限、沙箱或外部凭据。该 `management` 元数据由 Wish 在 Loader 前剥离，不会作为
插件配置传入业务实现。

Host 在 `ManagedPluginSnapshot.controls` 中逐 Entry 返回 `managementClass`、`canEnable`、
`canDisable`、`canReplace` 和稳定 `reason`，不公开表达式或环境值。Browser 只呈现这些 Host
结论，不提交 `safe`/`force`。委托 Entry 的 enabled/disabled 偏好都会在重启时重新叠加；
代码或配置重载会重新计算权限，但不会清除已经保存的偏好。

### 外部插件 manifest v1

`wish/plugins/manifest` 公开 v1 类型、解析器和 Config 校验器。静态 JSON 必须声明：

- `apiVersion: "wish.plugin/v1"`、稳定 `id`、相对 manifest 的实际 `entry`；
- `managementClass: "managed"` 与 `replacement: "drain" | "generation"`；
- 顶层为 object 的受限、确定性 JSON Config Schema；不支持的关键字 fail closed；
- `permissions.capabilities` 权限上限，以及与之相符的 filesystem/process/network Sandbox 通道；
- `state.mode: "stateless"`，或当前 `schemaVersion` 和包含当前版本的 `readableVersions`。

Host 在导入候选代码前检查 manifest 大小、字段白名单、API、入口真实路径、Schema 与当前配置、
权限/Sandbox 一致性和状态声明。manifest 文件加入同一部署摘要和 Root 文件监听；修改它与修改
profile 一样走持久变更事务。活动后再用 Owner Registry 核验 stop/codeUpdate，并要求实际
`drain`/`generation` 与 manifest 相同；缺失或不一致均为 nonconformant，启停/替换被拒绝。

能力声明从不签发 Grant。v1 的 `trusted-in-process` 明确表示插件实现与 Host 同权运行；不可信
实现尚不能标为 managed，必须等待 Worker/子进程隔离。Cordis `inject` 仍是运行依赖的唯一权威，
manifest 不复制依赖图。Timer、Listener、子进程和后台 Promise 必须绑定 Fiber effect 或 Owner
清理；静态声明不能替代真实收尾。

### 配置文件重载

Root-owned `config-watch.ts` 复用原生 HMR `registerConfig()` 的精确文件监听与串行通知，
代码监听根为空，依赖绑定及监听器通过 Cordis effects 回收。配置监听不依赖业务 WebUI
是否启用，也不依赖 `CORDIS_HMR` 的值。默认 profile 的 WebUI 代码监听默认开启，
`CORDIS_HMR=0` 可关闭；代码监听是另一条经过同一管理写锁的路径。

文件变更调用 `ManagedPluginControl.reloadConfiguration()`：等待在途 UI 操作后，再读取
部署文件与最新已保存偏好。它与 UI 启停使用同一写锁、revision、持久化意图、所有者准入
和 Stop 协调路径，不直接调用 Include writer。UI 并发写入进入有界队列；开始执行前重查 revision，旧版本拒绝且不自动变基。
Loader 自身的越权写入仍使 profile 失去受控资格，不因允许文件更新而取消这道检查。

启用一个 Provider 会保存变更前的完整 managed 运行图，并在应用后核验这次实际转为 active
的全部 Entry，而不只核验用户点击的目标。候选激活失败时，先恢复目标 gate；若下游 Fiber
保留了本次启动错误，则只重建那些在事务前为正常／pending、事务后仍为 failed 的代次，
最后比较整图的 Entry 身份、gate、enabled 与 phase。只有整图回到旧状态才清除 pending 并
报告 rolled-back；无法证明时仍进入 recovery-required。

当前在线范围包括普通 Entry 的新增、删除、配置／gate／inject 更新和实现名称替换，
以及原生 Group 的增删、嵌套移动、gate／isolate 等元数据更新、条目重排与普通插件／Group
之间的类型转换。`ManagedProfileSource.changes()` 输出 add/remove/update/replace/reorder/retype，删除后重新加入
使用 Cordis 原生依赖传播：Consumer 保留自己的配置和 gate，等待缺失的服务，服务恢复后
重新初始化。新增条目缺少依赖可保持 pending；配置应用成功不等于所有实例已激活。
同一 ID 更换实现名称或类型时不继承旧实现的启停偏好（类型转换即使模块名相同也会清理）；
删除成功也会清理该条目的偏好。
跨组移动保留条目 ID 与身份未变的用户偏好，在目标作用域重新初始化并绑定服务。
组元数据或归属变化会把前后树中受影响的后代纳入收尾与持久化意图，即使后代的直接父 ID
没有变化。先移除旧归属，再交给 Loader 加载新结构，避免并发 Group.update 删除已被新组
接收的条目。纯重排保留业务 Fiber，不要求忙碌所有者停止；仅注释变化只更新摘要。
类型转换先删除旧 Entry 再创建新 Entry，确保旧 Group 的子树与 subgroup 引用不会残留在
新的普通插件上。旧子树中仍需保留的后代可以在同一版配置中迁出，其余随旧树移除。

Group 的免业务收尾资格依据实际原生 Loader `Group` 实现与配置子节点所有权检查，
不能仅凭 `group: true` 获得。带额外 inject 或非配置子 Fiber 的 Group、自定义 Group 实现
返回 `management_group_unmanaged`。新增／更换实现时，带 Group／EntryTree 标记的实现
不能伪装成普通插件绕过载体检查，返回 `management_entry_unmanaged`。原生 Include 的
`path`/`patches`/`enableLogs` 由 managed 读取器静态展开为原生 Group，所有来源文件参与同一
摘要和 Root 监听。文件必须存在；不执行 Include.initial 文件创建，也不挂载独立 writer。
ID 在展开后的完整配置中唯一，文件环（含 symlink）、过深嵌套、无效 patch 提前拒绝。
相对插件路径按各自来源文件解析。自定义 EntryTree 仍不在受控修改范围内。

有活动 Fiber 的目标及其受影响依赖先经过真实所有者报告和准入检查；工作未结束、未接入
收尾或处于加载／卸载中的模块拒绝变更。没有 Fiber 的条目，以及已稳定、effects 为空的
pending/failed Fiber，可以直接更新或删除；有预激活资源的 pending Fiber 仍拒绝绕过收尾。
保存意图后重查实际运行图，应用前重查这些未激活实例，避免等待持久化时发生激活竞争。
新增 Provider 引发已有 Consumer 的初始化失败也会导致本次应用失败，不能报告成功。

`snapshot().configuration` 单独提供 `watching`、`phase`、已接受版本 `digest` 与稳定 `code`，
随现有订阅／管理状态通知发布，不暴露路径、配置表达式或原始错误。无效 YAML、不支持的结构变化
或清理前拒绝保留最后接受版本；即使磁盘文件无效，UI 仍可针对该有效版本安全启停。
配置/偏好变更先等待当前 Step；读取到的候选文件在等待结束后重新校验，期间改动会拒绝。
领域报告 drain 时由 Owner 封准入并排空或交接自身工作；领域仍报告 blocked（例如 Owner
已进入关闭但结果未知）时不会强行清理，也不自动重放。持久回执完成前，新模块的后台派发与
下一 Step 都不会开放。

配置应用同样先保存 pending，使用 `configuration:` 前缀的请求 ID；内部 intent 的
`configuration` 记录前后部署摘要及各条目（含受影响后代）的变更类型、旧／新实现名称，不保存配置正文。
`retype` 另外记录 `beforeGroup`／`afterGroup`，要求两者为相反的布尔值；重启同时核对该版本的
名称与类型。旧格式增删改／重排意图仍可读取。
浏览器启停请求不能提交这份 Host 记录。成功后清除 pending，保存
`management_configuration_applied` 回执，保留身份未变条目的偏好并清除删除／替换身份的偏好；
清理前拒绝仅保存拒绝回执。开始清理后发生确定性候选激活／最终回执失败时，事务尝试从
保留的前版配置和偏好重建旧代；只有结构、Fiber/Owner、偏好和持久回执均核验成功，才清除
pending 并记录 `management_configuration_rolled_back`。清理结果未知、保存结果不确定、恢复失败
或受影响依赖无法证明恢复时，继续保留 pending 与隔离状态。
重启优先接受记录中的前版或后版部署。若部署后来又变化，则逐项核对每个不确定目标仍是记录中的
前版或后版插件身份／类型；核对通过后，仍存在的普通目标同样在激活前隔离停用，按任一记录版本
应不存在的目标允许缺席。新增的无关条目不绕过这些隔离；目标被第三次替换或改型仍拒绝启动。
原生 Group 保持挂载，让被隔离的子条目可寻址；恢复入口确认后清理缺席目标的偏好，普通目标
保持停用，不给 Group 写入额外停用偏好，因此恢复后仍能逐个启用子插件。不重放增删改、Run 或 Tool。
无法与任一记录身份对应时返回 `management_profile_entry_changed`，须先核对并恢复记录中的版本；
不宣称代码／配置回退撤销了业务副作用。旧格式启停和代码重载 intent 继续使用原恢复规则。

Root 管理监听器与安全 API 由 Apps 组合提供，Boot 不导入前端模块。Root 最小管理基础设施
不提供自身的运行时停用按钮；业务基础设施必须满足真实所有者报告与收尾协议。已接入
Skills 的全部可选 Consumer，以及 Context/tmux/Subagent 观察入口的准入和注销；未接入
或有活跃工作的分支仍 fail closed。受控配置与 Settings 是不同能力。

### 统一变更协调

Root 上唯一的 `PluginChangeCoordinator` 是 UI 启用／停用、配置文件重载、原生 HMR 和独立
stop 的共同顶层入口。每次变更获得持久 operation identity、来源、类型、目标和同一个
`PluginChangeScope`；管理停用调用 stop 时复用该 scope，不会嵌套申请第二个变更锁。
阶段只能从 preflight 单调前进到安全点等待、fence、drain、stage、switch、retire、verify，
最后诚实落为 succeeded、rejected 或 recovery-required。Root 关闭会中止共享 signal；标为
rejected/recovery-required 的工作在实际 promise 结束前仍占有协调权，不能提前放行下一次变更。

`submit()` 只有在 queued operation 原子落盘后才返回 ID；`get`/管理 HTTP 查询持久状态，不依赖
原提交连接继续存在。队列、安全点等待和 preflight 可取消；进入 fencing 以后拒绝取消。
调用方等待超时或断线不向 Host operation 传播取消，现有同步 `change()` 只是内部兼容等待层。
`ManagedPluginStore` v2 把 operation journal 与偏好/pending/receipt 串行写入，但阶段更新不改变
配置 revision。重启读取 v1 时原地升级；读取未完成 v2 operation 时绝不重放：有匹配 pending
intent 的归为 recovery-required，其余归为 rejected/interrupted。

`SafePluginChangeTransaction` 统一三种失败边界：首个运行时副作用前失败为 unchanged/rejected；
候选失败后成功重建并核验最后提交代为 rolled-back/rejected；无法证明清理或恢复则为
recovery-required。启停恢复旧 gate 与偏好，配置恢复旧结构和条目身份，代码替换保留旧模块
namespace/插件 callback 并创建新的旧实现 Fiber。事务只恢复受控插件代次，不伪造任意领域副作用回滚。

管理 HTTP 的 `POST /api/management/plugins/change` 返回 `202 { operation }`；
`GET /api/management/plugins/operations/:id` 查询当前持久阶段；取消接口接收 operationId。
SSE 仍只发 invalidation，Browser 可重新查询或轮询，不把事件流当作事实日志。

### 受控代码替换

`code-reload.ts` 复用 Cordis 原生模块图与替换实现。受影响 Owner 的支持状态、prepare guard
及替换后的新代注册都从 `PluginOwnerRegistry` 读取，不再维护独立 safe/restart Owner 表。
它只接纳模块自己声明且影响闭包完整的所有者；未知所有者或未知依赖传播在卸载前拒绝。
第一方 Runtime/Session/Application 等稳定业务 Owner 已提供 generation、lease 或 drain 协议，
不再因为模块名称被固定判为重启边界。
managed 装配给它注入 Host-only `CodeReloadTransaction`，原生 `hmr/reload-batch` 在分析、
缓存和导入前进入 `ManagedPluginControl.runCodeReload()`，与 UI/文件写入互斥。
管理环境统一强制 HMR 的 `watchConfig: false`，包括直接地址加载的 HMR 实例；Root 的
精确 `registerConfig()` 监听不受影响，不允许第二条 Include.refresh 配置应用通道。

批次获得一次性 `CodeReloadPermit`，等待 Step 完成后、替换前持久化 `code-reload:` 意图；
实际替换、所有者与配置复核、成功回执落盘全部在 Step barrier 内完成。批次结束后 permit
失效，不提供给模型、浏览器或能力模块。成功不改变偏好；已停用实现的缓存更新不重新启用。
导入失败不留下卸载意图，旧实例仍可用；候选启动确定失败时，原生 HMR 先完整清理候选，
恢复保留的旧模块缓存和 plugin callback，等待旧 Fiber/Owner 重新激活，再由管理事务写入
`management_code_reload_rolled_back` 并开放 Step。清理／激活超时、旧代恢复失败或结果落盘
不确定仍保留 pending、封闭后续 Step，并沿用新进程实例隔离与 `recoverDisabled()`，不能在
故障 Root 直接清空状态。
同一个批次结束前并发 UI 写入和文件变更均持久排队。等待中的请求可通过 `/plugins/cancel`
按 operationId 取消；浏览器等待期限结束不取消 Host 工作。进入 fencing/清理后不接受取消。
`snapshot().requests` 提供排队、等待 Step、应用三个兼容投影；相同 requestId/指纹去重。

基础 Tool 的 `ManagedToolOwner` 自己拥有执行计数与停用 fence：有在途请求时排空，成功收尾注销 Tool；
它不把资源管理职责交给 Tools Registry。代码替换则等待完整 Step，包括审批与 Tool 执行。
只读 `snapshot().codeReload` 随已有 API/SSE 发布，不把模块路径或原始异常发给浏览器。
调度器/传输的接管由模块通过 `prepare()` 暂停准入并排空在途调用，成功回执后才经
`startWhenReady()` 恢复自动调度；Workflow 父 Run 等待关系由独立常驻的领域所有者保留。
目前支持范围和未声明依赖的拒绝边界见 [Boot 生命周期](../README.md#生命周期与重载)。
任意领域 schema 迁移不在此契约内；UI 模块使用独立的
[Browser 代码更新](../../apps/webui/client/README.md#界面代码更新)，不向浏览器暴露 Host 重载事务。

验证：`npm run test:webui-next` 包含真实 Loader 保存、重启、恢复、Root HTTP、安全边界、
实际 Skills 启停与 Client Models。`npm run test:webui-next:browser` 另验真实浏览器操作，
使用本地模拟 Provider；不等于外部 Provider 或部署验收。

## 文件与验证

- `types.ts`：不依赖 Node、Cordis 或 UI 框架的只读协议。
- `management-types.ts`：浏览器可用的选择、配置状态、操作状态与停用条件协议。
- `selection.ts`：单快照的显式多 Entry 校验、配置后代与运行依赖影响。
- `assessment.ts`：汇总 Host 与模块报告；未知条件 fail closed，不执行操作。
- `inspection.ts`：使用当前 npm 锁定 Cordis 版本的 Host 适配。
- `owner-registry.ts`：单一 Fiber generation Owner 声明、registration identity、统一 guard、
  旧 API 兼容合并，以及受管 Fiber 配置更新的 UID 串行与代际稳定门。
- `change-coordinator.ts`：四类顶层插件变更的持久接纳、FIFO、身份、目标、取消边界与单调阶段状态机。
- `safe-change.ts`：共享的 unchanged、verified rollback 与 recovery-required 失败边界。
- `lifecycle.ts`：Owner Registry 的限时只读查询/停用适配与过期报告淘汰；不再拥有独立声明表。
- `stop-contract.ts`：仅进程内可用的模块 guard 与 Host reservation 接口。
- `stop.ts`：串行协调、执行边界复核、有界等待和诚实失败回执，不拥有配置写入或模块实现。
- `managed-profile.ts`：最后接受的部署版本、稳定身份校验及独立偏好叠加；从不写部署文件。
- `manifest.ts`：外部 v1 manifest、入口/Config/权限/Sandbox/状态的严格静态校验与浏览器安全投影。
- `managed-control.ts`：UI、文件与代码更新的单写协调、持久化意图／回执和显式恢复。
- `code-reload.ts`：原生 HMR 与 Step 边界的适配，通过 Owner Registry 校验/准备受影响所有者并发布只读通知。
- `config-watch.ts`：Root-owned 原生配置监听，生命周期独立于业务树。
- `scripts/accept-plugin-inspection.mjs`：真实 Loader/Include 装配、依赖、隔离和启停观测。
- `scripts/accept-plugin-management.mjs`：四类管理语义、旧实例选择、缺失报告、状态与边界验证。
- `scripts/accept-plugin-owner-registry.mjs`：单次完整登记、旧 API 合并、冲突拒绝、代次失效与 restart 债务表示。
- `scripts/accept-plugin-change-coordinator.mjs`：持久接纳、FIFO、阶段单调、取消边界、恢复态持锁、Root 关闭、安全错误码与安全事务三种结果。
- `scripts/accept-plugin-lifecycle.mjs`：真实生产装配的查询、注册代次、隔离、异步失效与信息边界。
- `scripts/accept-plugin-stop.mjs`：准入、真实模块收尾、依赖顺序、旧引用、超时与部分失败；`npm run test:plugin-stop`。
- `scripts/accept-managed-config.mjs`：配置与偏好并发、部署约束、拒绝／隔离、依赖等待及监听回收。
- `scripts/accept-managed-config-webui.mjs`：真实 WebUI 管理 API、Skills 生命周期、原生文件监听、无效文件恢复，以及默认关闭的 Memory Curation/Web Fetch 启停和依赖恢复。
- `scripts/accept-managed-code-reload.mjs`：真实 WebUI/Read/Run、原生代码监听、候选激活失败的旧代恢复、并发配置、持久化失败及新 Root 隔离恢复，不使用外部 Provider。
- `scripts/accept-managed-core-owners.mjs`：11 个共享核心 Owner 的逐项停启与原生换代，以及 WebUI 业务入口在 Root Host 存活时的停启／替换。
- `scripts/accept-external-plugin.mjs`：外部 manifest fail-closed、class-only 不晋级、配置校验、
  Provider/Consumer 级联、旧引用、重复注册、配置替换和替换模式不一致回滚。
- `type-tests/plugin-inspection.ts`：只读 API、不可变返回值与三类状态的类型边界。

```bash
npm run typecheck
npm run test:plugin-inspection
npm run test:plugin-management
npm run test:plugin-change-coordinator
npm run test:plugin-lifecycle
npm run test:managed-config
npm run test:managed-code-reload
npm run test:module-boundaries
```

测试使用临时 home、Workspace、配置和数据目录；不访问用户的 Skill 或 Memory 库。

## 公共适配与覆盖边界

`wish/plugins/work-owner` 导出准入/排空/清理协议，`wish/tools/managed` 导出 Tool 包装，
`wish/plugins/manifest` 导出静态规范类型和纯校验入口。
[外部插件样例](../../../examples/plugins/greeting/README.md) 展示配置、required inject、
输入校验、能力声明和旧引用失效。完整检查入口是 `npm run test:plugin-adaptation`。

`snapshot().owners` 逐 Fiber 展示生命周期和代码更新的实际注册情况。
`registered` 只表示声明已接入，不能替代依赖闭包、活动工作、同一 revision 和恢复入口检查。
`snapshot().protocols` 再按普通 managed Entry 聚合活动 Fiber，分别输出：

- `stop: online`：每个活动 Fiber 都提供查询和真实 stop guard；`restart`：所有未提供 guard 的
  Fiber 都明确登记为重启边界；`missing`：至少一个活动 Fiber 没有安全停用协议；`inactive`：
  当前没有活动 Fiber，不能从运行态证明其实现。
- `codeUpdate` 使用同样的 `online / restart / missing / inactive` 词汇表达代码替换策略。
  `conformance` 只是两轴摘要；`restart` 是迁移期诊断，和 `incomplete` 一样不能通过 managed
  最终覆盖门禁。

客户端只呈现这份 Host 结果：Kernel／结构项保持灰色只读，普通插件的协议缺口或重启限制
使用黄色警告，不能把它们伪装成 Kernel。对活动影响闭包发现 `missing` 时，Host 在写入 pending
意图和调用任何清理前返回 `management_plugin_nonconformant`。这仍是运行后声明检查；尚未运行的
新插件需要后续安装／激活关卡验证，不能把 `inactive` 当作合规证明。

普通 Tool/Provider 用 `PluginWorkOwner`；显式调用句柄由其调用者释放，不能把 Session、
Step 或 Archive 的调用方租约错误改成 Provider 强制关闭。Consumer 完整收尾后才封住 Provider。

当前第一方 Run/Session/进程业务 Owner 均支持同进程停启与代码换代。Runtime 创建并拥有
Run generation；CLI/WebUI 退役各自通过 Application 打开的 generation；Agents/Application
只封住 factory/facade 准入与旧引用，不重复退役同一代。Approval 取消待决请求，Journal
排空写入，Session/Storage 通过句柄与 lease 完成真实关闭。Models 的 Session reasoning 存储按
操作获取当前 Backend lease，避免长期动态引用绕过 Provider 影响闭包。Runtime 自身换代会让
受影响 Run 以明确 abort 终态结束，不声称迁移正在执行的 JavaScript 栈。
在线更新不支持任意领域 schema 迁移、任意自定义 carrier，以及未经声明的外部引用；
这些范围不能仅靠 `codeReload: true` 获得安全保证。
