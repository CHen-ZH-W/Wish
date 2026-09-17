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

`bootstrap()` 在业务树加载前安装 Root-owned registry，并通过
`BootstrappedProcess.pluginLifecycle.collect(selection)` 暴露只读采集。
进程内 `ctx.pluginLifecycle` 还允许注册查询，外部读端口没有注册或启停方法；不得把
进程内 registry 的任意调用暴露为 HTTP/RPC。业务子树卸载不会撤销 Root 采集入口，
但这不等于独立 HTTP 管理入口已经实现。

模块在自己的 Cordis 装配边界调用 `registerPluginLifecycle(ctx, query)`，不增加必需的
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
| Runtime Provider | 已创建 RunGeneration 的活动 Run、退休中代次数量；活动或退休中返回 blocked，不发送 abort |
| File Storage Provider | 该 Backend registration 的真实 lease 数与关闭状态；lease 未释放返回 drain，退休或关闭失败返回 blocked |
| Workflow Scheduler | 请求、排队 tick、等待中的父 Run、持久 Workflow/Attempt，以及尚未创建 Workflow 的 graph start；未收尾时 blocked |
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

模块可在装配边界传入 `registerPluginLifecycle(ctx, query, prepare)` 的第三个参数。
`prepare()` 必须同步封住该代所有新准入（包括已经返回的旧引用），不取消已有工作；
若抛错必须保持原样。返回 guard 的 `release()` 只撤销尚未提交的准入限制，必须幂等、
不抛错；`close()` 则复用模块真正的幂等资源清理 Promise，不能只撤销查询注册或隐藏 UI。
没有 stop guard 的任何受影响所有者都会使整个操作拒绝，不按模块名补充默认清理逻辑。

执行顺序是：

1. 捕获显式选择、采集当前所有者，并取得受信任 Host 配置／恢复 reservation。
2. 检查所有受影响所有者均支持协议，再同步封住准入；重新采集并评估模块条件。
3. 按实际所有权／绑定关系先收尾子级和 Consumer，再收尾父级和 Provider；依赖环拒绝。
4. 每个异步边界重查注册代次、配置 reservation 与运行树；模块清理全部成功后才调用 Host apply。
5. 等待 apply、Host verify，再独立确认 gate 已关闭且旧影响 Fiber 不再运行，才报告成功。

只支持当前 active 的普通插件条目；Group carrier、缺席、pending 或未覆盖分支拒绝，
不把配置专用操作伪装成运行资源关闭。批量操作不是原子事务。模块状态仍归各自所有者，
管理层只协调 guard，不复制 Run、Workflow、child 或 lease 状态，也不新增后台 Bash 管理。

| 模块 | 准入与真实清理 |
| --- | --- |
| Runtime | 同时封住 `open()` 与已返回 RunGeneration 的 `startRun()`；活动或退休中 Run 阻止停用，空闲代才 retire/release，不借 retire 隐式 abort 活动 Run |
| File Storage | 封住 Hub 获取及子 lease 派生；已有 lease 完成已接纳工作并由原所有者释放，随后 unregister 等待物理 close；旧 facet 随物理关闭失效，不删除数据 |
| Workflow Scheduler | 封住 graph start、submit/retry/cancel/watch 和新 timer/event tick；已有请求、tick、父等待和未收尾记录阻止停用，允许后才关闭两类 scheduler |
| Subagents | 封住服务请求与订阅；在途请求、监视器、live/未核对记录阻止停用；允许后关闭记录服务并释放 lease，不终止独立进程 |

`PluginStopHost.reserve()` 是进程内受信任适配接口，不是客户端填写的安全标记。它必须
排斥并发配置写入、保留独立恢复入口、校验实际 Entry/配置代次；apply 须保留部署约束、
等待 Loader 清理，且不能自动回滚部分副作用。本协议不请求持久化，成功明确返回
`persistence: not-requested`。不能直接拿 Include 的 `entry.update({ disabled: true })`
充当适配器：它可能覆盖条件表达式或间接写回部署文件。

协调器同一时刻只执行一个操作。默认总 deadline 30000 ms（可设 1–30000 ms）只限制
等待响应，不强杀资源。清理前拒绝可释放准入限制；一旦开始清理，任何失败或超时都保留
准入限制与配置 reservation，标记部分／未知结果，并拒绝后续操作为
`stop_recovery_required`。晚到 Promise 的拒绝被消费，但不会继续下一步、重放 apply 或
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
- 请求包含 Root instanceId、revision、显式 Entry IDs 和幂等 requestId。同一时刻一个操作；
  同请求只返回已有回执，冲突请求拒绝。先持久化 pending 意图，才封准入和执行资源收尾；
  成功或清理前拒绝再提交回执。最后 100 个回执有界保留，不承诺永久请求去重。
- 部分清理、apply 或持久化结果不确定时保留 pending 与已加的限制，状态为
  recovery-required。不能通过自动重试或反向启用恢复未知副作用。
- 重启时 pending 的目标 gate 被隔离关闭；Root 管理入口可核对并显式确认保持停用。
  同一故障进程不能直接清除该状态。恢复不删除领域数据、不重新执行 Tool，也不重放 enable。
- `plugins.json.lock` 与 Settings lock 使用进程身份和 nonce 排斥第二个文件写者；关闭不移除
  其他所有者的替换锁。崩溃残留锁不自动偷取：必须确认旧进程已退出，备份并核对状态后，
  由操作员移除准确的对应 lock 文件，再重启。损坏文档、身份漂移不能靠一键恢复覆盖。
- Stop 等待有总 deadline；启用遵循插件自己的初始化生命周期。浏览器等待超时不意味着
  Host 操作被取消，仍须查看 working/pending 状态，不能盲目重发。忽略退出的插件可能需要
  运维在确认状态后结束进程；这里没有强杀和假成功。

### 用户激活委托

默认策略仍是 fail closed：未声明管理元数据的 Entry 只能停用或恢复部署默认值，不能用
`enabled` 偏好覆盖部署表达式。需要允许 WebUI 打开的默认关闭能力，由部署 profile 在该
普通 Entry 上显式声明：

```yaml
management:
  activation: user
  constraint: !!js launch.environment.EXAMPLE_ENABLED === '0'
```

`activation: user` 只把该 Entry 的默认关闭 gate 交给用户；`constraint` 是单独的硬阻止条件，
求值为 true、求值失败或所需部署事实不可用时均不允许启用。它不适用于 Group，也不授予
配置字段、权限、沙箱或外部凭据。该 `management` 元数据由 Wish 在 Loader 前剥离，不会作为
插件配置传入业务实现。

Host 在 `ManagedPluginSnapshot.controls` 中只公开逐 Entry 的 `canEnable` 布尔值，不公开表达式
或环境值。Browser 据此区分红色“已停用”（允许用户启用）与灰色“条件未满足”（不可绕过）；
它不维护插件名单。委托 Entry 的 enabled/disabled 偏好都会在重启时重新叠加；代码或配置
重载会重新计算权限，但不会清除已经保存的偏好。

### 配置文件重载

Root-owned `config-watch.ts` 复用原生 HMR `registerConfig()` 的精确文件监听与串行通知，
代码监听根为空，依赖绑定及监听器通过 Cordis effects 回收。配置监听不依赖业务 WebUI
是否启用，也不依赖 `CORDIS_HMR` 的值。默认 profile 的 WebUI 代码监听默认开启，
`CORDIS_HMR=0` 可关闭；代码监听是另一条经过同一管理写锁的路径。

文件变更调用 `ManagedPluginControl.reloadConfiguration()`：等待在途 UI 操作后，再读取
部署文件与最新已保存偏好。它与 UI 启停使用同一写锁、revision、持久化意图、所有者准入
和 Stop 协调路径，不直接调用 Include writer。UI 并发写入返回 busy；旧 revision 拒绝。
Loader 自身的越权写入仍使 profile 失去受控资格，不因允许文件更新而取消这道检查。

当前在线范围是普通 Entry 的配置、gate、inject 等属性；名称、ID、父子结构、条目顺序
及 Group 元数据必须保持一致。身份／结构改变返回 `management_profile_structure_changed`，
需单独迁移并重启，不自动重新绑定已有偏好。仅注释变化更新摘要，不重建业务 Fiber。

有活动 Fiber 的目标及其受影响依赖先经过真实所有者报告和准入检查；工作未结束、未接入
收尾或处于加载／卸载中的模块拒绝替换。配置缺少依赖时，已启用 Entry 可处于 pending，
不能把配置保存成功当作实际激活成功。

`snapshot().configuration` 单独提供 `watching`、`phase`、已接受版本 `digest` 与稳定 `code`，
随现有订阅／管理状态通知发布，不暴露路径、配置表达式或原始错误。无效 YAML、结构变化
或清理前拒绝保留最后接受版本；即使磁盘文件无效，UI 仍可针对该有效版本安全启停。
忙碌拒绝不自动排队重试，可在条件满足后重新提交文件变更或由 Host 再请求重载。

配置应用同样先保存 pending，使用 `configuration:` 前缀的请求 ID，但不生成新的用户偏好。
成功后清除 pending，保存 `management_configuration_applied` 回执并保持偏好；清理前拒绝
仅保存拒绝回执。开始清理后发生激活／保存失败，保留 pending 与隔离状态；重新启动时
隔离所有尝试更新的目标，由现有恢复入口核对并明确保持停用，绝不自动回放任务或宣称
代码／配置回退已撤销业务副作用。

Root 管理监听器与安全 API 由 Apps 组合提供，Boot 不导入前端模块。Root 最小管理基础设施
不提供自身的运行时停用按钮；业务基础设施必须满足真实所有者报告与收尾协议。已接入
Skills 的全部可选 Consumer，以及 Context/tmux/Subagent 观察入口的准入和注销；未接入
或有活跃工作的分支仍 fail closed。受控配置与 Settings 是不同能力。

### 受控代码替换

`code-reload.ts` 复用 Cordis 原生模块图与替换实现。它只接纳模块自己声明的 Step-local
所有者，未知所有者、稳定 Runtime/Session 或未知依赖传播在卸载前拒绝。
managed 装配给它注入 Host-only `CodeReloadTransaction`，原生 `hmr/reload-batch` 在分析、
缓存和导入前进入 `ManagedPluginControl.runCodeReload()`，与 UI/文件写入互斥。
管理环境统一强制 HMR 的 `watchConfig: false`，包括直接地址加载的 HMR 实例；Root 的
精确 `registerConfig()` 监听不受影响，不允许第二条 Include.refresh 配置应用通道。

批次获得一次性 `CodeReloadPermit`，等待 Step 完成后、替换前持久化 `code-reload:` 意图；
实际替换、所有者与配置复核、成功回执落盘全部在 Step barrier 内完成。批次结束后 permit
失效，不提供给模型、浏览器或能力模块。成功不改变偏好；已停用实现的缓存更新不重新启用。
导入失败不留下卸载意图，旧实例仍可用；卸载后或结果落盘不确定则保留 pending、封闭后续
Step，并沿用新进程实例隔离与 `recoverDisabled()`，不能在故障 Root 直接清空状态。
同一个批次结束前并发 UI 写返回 busy；文件写等待，停用请求不会被偷偷转成代码更新。

Read Consumer 自己拥有执行计数与停用 fence：有在途读取时拒绝停用，成功收尾注销 Tool；
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
- `lifecycle.ts`：Root 所有者注册、限时只读查询与过期报告淘汰；不拥有业务收尾。
- `stop-contract.ts`：仅进程内可用的模块 guard 与 Host reservation 接口。
- `stop.ts`：串行协调、执行边界复核、有界等待和诚实失败回执，不拥有配置写入或模块实现。
- `managed-profile.ts`：最后接受的部署版本、稳定身份校验及独立偏好叠加；从不写部署文件。
- `managed-control.ts`：UI、文件与代码更新的单写协调、持久化意图／回执和显式恢复。
- `code-reload.ts`：原生 HMR 与 Step 边界的适配、受影响所有者校验和只读通知。
- `config-watch.ts`：Root-owned 原生配置监听，生命周期独立于业务树。
- `scripts/accept-plugin-inspection.mjs`：真实 Loader/Include 装配、依赖、隔离和启停观测。
- `scripts/accept-plugin-management.mjs`：四类管理语义、旧实例选择、缺失报告、状态与边界验证。
- `scripts/accept-plugin-lifecycle.mjs`：真实生产装配的查询、注册代次、隔离、异步失效与信息边界。
- `scripts/accept-plugin-stop.mjs`：准入、真实模块收尾、依赖顺序、旧引用、超时与部分失败；`npm run test:plugin-stop`。
- `scripts/accept-managed-config.mjs`：配置与偏好并发、部署约束、拒绝／隔离、依赖等待及监听回收。
- `scripts/accept-managed-config-webui.mjs`：真实 WebUI 管理 API、Skills 生命周期、原生文件监听、无效文件恢复，以及默认关闭的 Memory Curation/Web Fetch 启停和依赖恢复。
- `scripts/accept-managed-code-reload.mjs`：真实 WebUI/Read/Run、原生代码监听、并发配置、持久化失败及新 Root 隔离恢复，不使用外部 Provider。
- `type-tests/plugin-inspection.ts`：只读 API、不可变返回值与三类状态的类型边界。

```bash
npm run typecheck
npm run test:plugin-inspection
npm run test:plugin-management
npm run test:plugin-lifecycle
npm run test:managed-config
npm run test:managed-code-reload
npm run test:module-boundaries
```

测试使用临时 home、Workspace、配置和数据目录；不访问用户的 Skill 或 Memory 库。
