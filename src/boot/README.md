# Boot

`src/boot/` 是 CLI 与 WebUI 共用的进程启动层。它只负责创建 Cordis Root、提供启动事实、
加载配置树、转发进程信号和回收进程资源；Session、Storage、Workspace、Filesystem、权限、
Model、Context、Tool、Runtime 等业务能力仍由各自模块拥有。

```text
wish / wish-webui
        -> bootstrap()
        -> Cordis Root Context
        -> Loader -> Include -> cordis.yml
        -> isolated application group
        -> selected CLI or WebUI surface
```

Wish 要求 Node `^22.19.0 || >=24.0.0`。Cordis 及相关插件直接使用 `package.json` 锁定的
npm 发布版本，仓库不维护框架副本。

## 文件职责

- `launch.ts`：定义并创建不可变的进程启动事实，包括 surface、argv、cwd、home、environment、
  配置来源、完成通道和信号订阅。
- `bootstrap.ts`：创建唯一 Root Context，安装 Loader 与内置插件，装载 profile，并确认所有
  启用条目和目标 surface 已激活。
- `plugin-catalog.ts`：声明 Host 与 Tool 插件的真实模块入口，按需交给 Loader 导入；
  Node 模块解析和 HMR 对同一个 `cordis:` 别名使用同一个模块地址。别名与 Entry ID
  保持稳定，既有启停偏好无需迁移。解析注册随 Root effect 注销，Boot 不静态导入业务实现。
- `plugin-control/`：Root-owned 插件检查端口，投影 Loader 条目、Fiber 状态与已绑定依赖，
  提供只读停用影响预览、显式条目选择与管理状态协议，以及缺省拒绝的 Host 条件评估；
  `pluginLifecycle.collect()` 向绑定到实际 Fiber 的模块查询资源条件，失活或过期报告拒绝复用；
  `pluginStops` 独立协调模块准入、清理与 Host 应用；生产配置／恢复适配器缺席时拒绝执行，
  不直接回写 profile、不替业务模块管理任务。详见
  [插件检查约定](plugin-control/README.md)。
- `config/cordis.yml`：默认业务依赖图及 CLI/WebUI 的互斥启用规则。

正式 Application、CLI 和 WebUI 插件分别位于 `src/apps/service.ts`、
`src/apps/cli/plugin.ts` 和 `src/apps/webui/plugin.ts`。其他能力插件也放在自己的模块中，
不建立统一的插件容器。

## 配置来源

Cordis profile 按以下优先级选择：

1. `bootstrap({ configurationFile })`；
2. `CORDIS_CONFIG`；
3. 随构建发布的 `config/cordis.yml`。

字符串路径相对 `launch.cwd` 解析，URL 只接受 `file:`。最终路径与来源通过
`launch.configurationFile` 和 `launch.configurationSource` 暴露。Cordis profile、插件和
其中的 `!!js` 表达式可以执行本地代码，因此外部配置文件属于受信任代码边界。

默认 profile 在 Loader 边界把兼容的 `WISH_*` 环境变量显式映射到各插件配置；自定义
profile 不会隐式继承这些普通配置。Provider 凭据仍由 Model Adapter 在请求时从
`launch.environment` 读取，不进入配置快照或 Session。

环境变量不再是所有可选功能的唯一启用入口。默认 profile 可用 Wish 自有的
`management.activation: user` 将“默认关闭、但允许用户打开”的 gate 委托给受控管理面；
WebUI 只消费 Host 返回的启用权限，不按 Entry ID 猜测。首批包括 Memory Curation、它的
Runtime/Workflow Evidence Consumer，以及 HTTP Web Fetch Provider/Tool。显式关闭 Memory、
子进程隔离、缺失 SearXNG 地址等部署条件仍是硬约束，浏览器不能越过。详细语义见
[用户激活委托](plugin-control/README.md#用户激活委托)。

同一个 Include/EntryTree 中的 `id` 必须全局唯一。配置应使用带能力或隔离域前缀的稳定
ID，避免 Loader 把同名条目误判为移动或更新。

## 默认依赖图

默认 profile 在私有 `app` realm 中按依赖关系组合：

```text
sessionPersistence <- file session provider
sessions <- sessionPersistence
storage <- file storage backend (KV / Blob / Journal) -> storageBackend
runtimeLifecycle <- Journal Runtime Provider <- storageBackend
modelCatalogPersistence <- Storage Domain Provider <- storageBackend
toolResultArchive <- Blob archive provider <- storageBackend
toolOutputArtifacts <- Blob artifact provider <- storageBackend
workspace <- local workspace provider
skills <- local package provider <- launch home + Host Workspace cwd
memory <- Journal library provider OR Host-pinned child snapshot provider
memoryCuration <- optional scheduler <- memory + storageBackend
filesystem <- local filesystem provider
filesystemSearch <- local search provider <- filesystem policy generation
shell <- Linux Native provider <- filesystem policy generation
tmux <- local tmux provider <- private synchronous command runner
subagentExecution <- tmux adapter <- tmux
subagentLauncher <- CLI adapter <- launch + sessions
subagents <- domain Runtime <- subagentExecution + subagentLauncher + storageBackend
approval <- process-surface answerer hub
approvalRules <- Storage Domain provider <- storageBackend KV
sandboxPolicy <- default preflight provider <- filesystem + shell policy generation
permissions <- default policy provider <- approval + approvalRules + sandboxPolicy
plan <- Session-keyed Storage Domain + Permissions policy + Context provider
coordinator <- Run-keyed Storage Domain + Permissions policy + Context provider + subagents
tasks <- Session-keyed versioned graph Storage Domain
workflow <- Run snapshot + Attempt ledger Storage Domain
workflowScheduler <- workflow + tasks + plan + subagents + current permission/workspace checks
models <- model adapter plugins
contextEngine + compaction
tools <- read/write/edit consumers <- filesystem
      <- grep consumer <- filesystemSearch
      <- bash consumer <- shell + toolOutputArtifacts
      <- subagent Tool consumer <- subagents + runtime completion control
      <- Plan Tool consumer <- plan
      <- Tasks / Workflow Tool consumers <- independent capability services
      <- Coordinator Tool consumer <- coordinator
agentLoop <- runtimeLifecycle
runEngine <- sessions + models + runtimeLifecycle (每 Step 动态获取 agentLoop)
agents
application
cli | webui
```

Root 只共享 `launch`、Loader、Timer 和 HMR 等进程基础设施。`BootstrappedProcess.context`
始终指向 Root；`surfaceContext` 指向目标 surface 所在的隔离 realm，用于访问该业务图。
同一 Root 可以承载多套同名业务 service，而不会共享 Session、Registry、Agent 或 Runtime
配置。

显式 `bootstrap({ management })` 还在 Root 安装独立管理协调与恢复入口，业务树改由受控
profile 装载，保留部署原文并叠加单独持久化的启停偏好。Root 使用原生 HMR 的
`registerConfig()` 独立监听部署配置；默认 profile 的 WebUI 业务代码监听默认开启，
`CORDIS_HMR=0` 可关闭。CLI/子进程仍需 `CORDIS_HMR=1` 显式开启；代码替换经过受控重载事务。
WebUI 产品入口固定使用这套组合，并由 Apps 提供 Root HTTP 与 Settings，
Boot 不拥有具体 UI。业务 surface 缺席或 pending 时管理面仍可供检查；管理文件损坏、
独占锁冲突或部署配置无法解析属于启动错误，不假装业务已恢复。见
[受控配置与恢复](plugin-control/README.md#受控配置与恢复) 和 [WebUI](../apps/README.md#独立管理面)。

每个插件拥有自己的 Schemastery 配置：

- SessionPersistence：可替换 Session Store factory；Sessions：数据目录；
- Storage：具名 Backend 注册；File Provider：Backend ID、显式存储根目录与 Journal torn-tail 策略；
- RuntimeLifecycle：绑定的 Storage Backend ID；业务事件格式和恢复分类仍归 Runtime；
- ToolResultArchive：绑定的 Storage Backend ID；
- ToolOutputArtifacts：绑定的 Blob Backend ID；
- Workspace：instruction 文件名、repository markers 与读取字节上限；
- Skills：用户根目录、包数量／文件字节上限；Context Consumer：目录条数／字符预算；
- Memory：Storage Backend 与共享库 ID；Child Snapshot：仅接受 Host 注入的执行身份与资源 manifest；
- MemoryCuration：可由受控管理面启用，自动扫描、间隔、并发、尝试次数与超时仍来自部署配置；
- Filesystem：文件大小上限与受保护目录/文件名称；
- FilesystemSearch：最大扫描文件数与目录数；
- Shell：native launcher、默认/最大 timeout；Host Provider 需要双重显式启用；
- Tmux：可执行文件、socket、会话前缀与 capture 上限；
- SubagentExecution：透明执行 Provider；SubagentLauncher：host-owned child App 入口；
- Subagents Runtime：Storage Backend、全局/每 Run 并发和记录上限；
- Approval：进程表面 answerer 的生命周期；ApprovalRuleStore：持久 backend 与规则上限；
- SandboxPolicy：当前 Filesystem/Shell generation 的审批前可执行性；
- Permissions：默认 profile 与 policy version；
- Plan：Storage Backend；Coordinator：Storage Backend 与现有 Subagents capability；
- Models：配置来源、默认模型、fallback 与重试次数；
- ContextEngine / Compaction：各自的预算；
- Runtime：Step 上限与 generation 排空期限；
- Agents：Agent ID、instructions、permission profile、Tool 可见范围与 capability ceiling；
- WebUI：host、port 与 workspace root；
- Application：不重复声明上游业务配置。

CLI 的显式参数作为 surface override 传给 Application，不改变字段的 service 所有权。

默认 profile 还映射 `WISH_TMUX_SOCKET`、`WISH_TMUX_ENABLED`、
`WISH_SUBAGENTS_ENABLED`、`WISH_SUBAGENT_TOOLS_ENABLED`、
`WISH_SUBAGENT_MAX_RECORDS`、`WISH_SUBAGENT_MAX_CONCURRENT`、
`WISH_SUBAGENT_MAX_CONCURRENT_PER_RUN`、`WISH_SUBAGENT_EXECUTABLE` 和
`WISH_SUBAGENT_CLI_ENTRY`。tmux、Subagents capability 与模型 Tool Consumer 分别启用；
`WISH_SUBAGENT_TOOLS_ENABLED=0` 只卸载模型入口。内部 child 进程将
`WISH_SUBAGENTS_ENABLED=0` 和 `WISH_SUBAGENT_TOOLS_ENABLED=0`，避免递归创建同一管理分支；
launcher 同时固定独立的 `WISH_DATA_DIR` 与
`WISH_STORAGE_FILE_ROOT`，不会与父进程共享 Session 或 Runtime Journal。

Plan 默认启用，可分别用 `WISH_PLAN_ENABLED=0` 和
`WISH_PLAN_TOOLS_ENABLED=0` 关闭能力或模型入口。Coordinator 默认在 Subagents 可用时启用；
`WISH_COORDINATOR_ENABLED=0` / `WISH_COORDINATOR_TOOLS_ENABLED=0` 分别关闭其能力和模型入口。
两者是独立一级模块：Plan 只冻结已审批方案，不启动 Workflow；Coordinator 只改变当前
Run 的委派策略，不接管 tmux 或 child lifecycle。

Tasks 与 Workflow 默认启用；`WISH_TASKS_ENABLED=0` / `WISH_WORKFLOW_ENABLED=0` 分别关闭
能力，`WISH_TASK_TOOLS_ENABLED=0` / `WISH_WORKFLOW_TOOLS_ENABLED=0` 只隐藏相应模型入口。
`WISH_WORKFLOW_MAX_CONCURRENT` 设置 Scheduler 并发上限。默认 `spawn_agent` Consumer 经由
Workflow 调度；关闭调度前置能力后恢复独立 Subagents Consumer，同名 Tool 不重复注册。
Plan 的 `exit_plan_mode` 只提交评审，人工批准后才退出；Tasks、Workflow 状态和人工核对
通过 Apps 的通用 Session Feature 接口展示。内部 child 禁用 Tasks/Workflow，保持独立数据目录。

Boot 的内置插件名录位于 `plugin-catalog.ts`，并明确分成 Host/Runtime capability 与
model Tool Consumer 两张表；`configuration.ts` 只解析配置文件来源，Loader 才拥有配置
求值和重载。Web Provider 与 Tool 暴露也分别控制：`WISH_WEB_FETCH_ENABLED=1` 和
`WISH_WEB_SEARCH_PROVIDER=searxng` 启用能力，而 `WISH_WEB_FETCH_TOOLS_ENABLED=0`、
`WISH_WEB_SEARCH_TOOLS_ENABLED=0` 可只隐藏模型入口。

## Skills 与 Memory 的可选装配

默认开启 Skills、Memory 能力、Context Consumer 和模型读取入口。只有候选提交
`memory_write` 暴露给模型，采纳／拒绝仍属于人类 SessionFeature；Plan／Coordinator
适配器只允许读取。以下开关彼此独立，值 `0` 表示禁用：

| 环境变量 | 禁用范围 |
| --- | --- |
| `WISH_SKILLS_ENABLED` | 整个 Skills 能力及其 Consumers |
| `WISH_SKILLS_CONTEXT_ENABLED` | Skill 目录上下文 |
| `WISH_SKILLS_TOOLS_ENABLED` | list_skills、read_skill |
| `WISH_SKILLS_SESSION_FEATURE_ENABLED` | 人类目录与正文查看面板 |
| `WISH_MEMORY_ENABLED` | 整个 Memory 能力及其 Consumers |
| `WISH_MEMORY_CONTEXT_ENABLED` | 有界记忆索引上下文 |
| `WISH_MEMORY_TOOLS_ENABLED` | memory_search、memory_read、memory_write |
| `WISH_MEMORY_WRITE_ENABLED` | 仅 memory_write 候选提交 |
| `WISH_MEMORY_SESSION_FEATURE_ENABLED` | 人类候选审核面板 |
| `WISH_MEMORY_SUBAGENTS_ENABLED` | 父端知识快照委派和子候选回收 |

Skills 默认用户根目录使用 `launch.homeDirectory/.wish/skills`，可用绝对路径
`WISH_SKILLS_USER_ROOT` 覆盖；项目来源只有 Workspace 的 `.agents/skills`。
`WISH_SKILLS_MAX_SKILLS`、`WISH_SKILLS_MAX_FILE_BYTES` 和
`WISH_SKILLS_CONTEXT_MAX_ENTRIES`／`WISH_SKILLS_CONTEXT_MAX_CHARACTERS` 分别约束
来源和目录投影。查看面板不激活 Skill，不执行 scripts，不把 manual-only 包自动
变成模型可调用能力。

父端 Memory 使用当前 Storage Backend 的 Journal，库 ID 默认 `default`，由
`WISH_MEMORY_LIBRARY_ID` 覆盖；不另建可同时独立修改的 Markdown 主库。复用
`WISH_DATA_DIR`／`WISH_STORAGE_FILE_ROOT` 时需遵守 File Backend 进程内单写边界，
CLI 和 WebUI 不得作为两个写进程指向同一数据根。

内部 child 由 Host 固定 identity、Session／Run、独立数据目录和资源 manifest。
`WISH_CHILD_RESOURCES_FILE` 或 `WISH_CHILD_RESOURCES_DIGEST` 任意非空时只选择
child-snapshot Provider，缺失、损坏、身份或 digest 不匹配会使启动失败，绝不退回
可写主库。没有资源的 child 不启用 Memory；有资源的 child 只能读取委派快照并在
Host 授权时提出候选。child 不加载人类审核、curation 或父端候选回收 Consumer。
这些 `WISH_CHILD_*` 是内部协议字段，不是用户选择任意库路径的配置入口。

整理 Scheduler 默认不加载。`WISH_MEMORY_CURATION_ENABLED=1` 才启用其持久任务
能力及 Runtime 证据适配器；Workflow 证据适配器还要求 Workflow 启用。
`WISH_MEMORY_AUTO_CURATION=1` 只在 Scheduler 已启用时启动自动补扫；单独设置它
不启用整理。并发、尝试次数、超时和间隔分别由
`WISH_MEMORY_CURATION_MAX_CONCURRENT`、`WISH_MEMORY_CURATION_MAX_ATTEMPTS`、
`WISH_MEMORY_CURATION_TIMEOUT_MS`、`WISH_MEMORY_CURATION_INTERVAL_MS` 配置。
整理完成只生成候选，不能代替验证证据或人工采纳。

新服务 skills、memory、memoryCuration 与其余业务服务一样隔离在 app realm 内。
Context 在新 Step 捕获当前 Consumer 集合，同一 Step 重投影固定集合；卸载则取消
并排空进行中的读取。关闭 Tools 不关闭能力；关闭 Context 不删除持久记忆。

验收：`npm run test:skills`、`npm run test:memory`、`npm run test:memory:boot`。
真实 tmux 子进程验收为独立 `npm run test:memory-real`，不进入默认 `npm test`。
默认配置验收使用临时 home／Workspace／data root，不访问真实用户记忆库。

## 生命周期与重载

CLI 的执行 Promise、Terminal 和 signal subscription，以及 WebUI Server 的异步 setup，
都由对应 Cordis fiber 的 effect 持有。依赖消失时 consumer 进入 `PENDING`；依赖恢复后以
新的 service generation 激活。Root dispose 会回收信号监听、终端和 Server。

随构建发布的默认 profile 在 WebUI 启动时默认开启代码 HMR，直接 `npm run webui` 即可；
设置 `CORDIS_HMR=0` 显式关闭，`CORDIS_HMR=1` 显式开启。未设置变量时 CLI/子进程仍默认关闭；
其他显式值不启用。自定义 profile 及已保存的停用偏好不被启动脚本强制覆盖。
监听对象是 `dist/` 下实际加载的模块；修改 `src/` 仍需编译为实际加载的 JavaScript。
HMR 的 `base` 相对 profile 目录解析；把默认 profile 复制到别处时，应相应调整
`base` / `root`，不要意外监视工作区之外的父目录。
业务插件的稳定 `cordis:` 别名由 Loader 按需导入，并参与原生 HMR 模块图分析；
共享实现文件可能使多个入口一起替换，并不保证每个条目都是独立重载单元。
完整构建会重写多个已加载文件，原生监听并不按内容摘要排除未变文件；因此一次全量编译
可能触及不可重载的状态所有者并被拒绝，不能将编译成功当作局部在线替换成功。
原生 HMR 的 `hmr/reload-prepare` 在实际卸载之前调用 Root 协调器，等待所有已登记 Runtime
的完整 Step 收尾，再按 Consumer → Provider 的依赖顺序暂停新调用、排空在途操作，
然后删除旧注册、等待 Loader 的完整异步激活链结束。当前声明支持 AgentLoop、Read、
Workflow 存储/调度、Subagents Runtime、tmux Provider/执行适配器及其已审查 Consumers。
未声明的目标及依赖传播影响一律拒绝，不按插件名称猜测安全性。Runtime、Session、Application、
Workflow 父 Run 等待关系所有者仍不可通过此路径在线替换。独立 Subagent result relay 和
Memory Workflow evidence 等未声明 Consumer 被启用时，相关依赖重载仍会拒绝。
三种在途时机（模型输出、审批、Tool 执行）下同一 Run 跨 Step 使用新实现已由原生文件修改测试覆盖。
Tool 自己修改代码时应返回“已受理”，不能等待需要它所在 Step 完成的替换结果。

`BootstrappedProcess.codeReload` 是只读状态与订阅端口，区分等待 Step、应用、成功、拒绝及恢复要求；
不暴露配置正文、模块对象或修改权限。导入失败保留旧实例；开始卸载后的初始化失败或超时会封闭
后续 Step 与重载批次，不自动回装旧插件或重放业务副作用。HMR 的 `reloadTimeout` 默认为 30000ms，
只限制卸载/激活，不限制等待用户审批的时间；超时后的迟到清理不会继续激活新插件。
框架/启动入口修改只报告需要显式重启，不自动退出宿主。
Browser UI 使用独立的版本化 ESM 模块清单，不由 Host HMR 卸载；业务 UI 构建、失败隔离、
常驻 Client Models 及显式刷新边界见 [Browser Client](../apps/webui/client/README.md#界面代码更新)。
非 managed 配置更新由 Include 处理；失败时尝试恢复 last-known-good 配置，不代表
业务副作用回滚。`disabled` 会卸载目标 fiber。

managed 配置监听独立于业务树，与 WebUI 启停共用同一个协调器。每次组合最新部署内容
和已保存偏好，保留用户停用及部署约束；只接受结构、名称与 ID 不变的普通 Entry 更新。
受影响的活动所有者必须先通过现有准入与收尾检查，忙碌或不支持者拒绝更新，不隐式中止 Run。
无效文件保留最后接受版本，仍可基于该版本执行受控启停；清理或激活后的失败保留 pending
隔离意图，要求显式恢复，不自动重放。API 的 `configuration` 区分监听、应用、拒绝与恢复状态，
只提供已接受版本摘要和稳定诊断 code，不返回配置正文。

managed 模式下，原生 `hmr/reload-batch` 在模块分析、缓存更新与导入前取得同一写锁，
代码更新、文件配置与 WebUI 启停不能交叠。文件更新等待当前操作；并发 UI 启停返回 busy，
不代表停用已经受理，调用方须在操作结束后重新提交。原生 HMR 的自动 Include 配置监听
被关闭，只保留 Root 独立 `registerConfig()` 路径，直接模块地址加载 HMR 也不能绕过。
完成 Step 排空后、实际卸载前保存 `code-reload:` pending，替换验证与成功回执落盘后才
开放下一 Step、新调度器的后台派发及对应 Session Feature；不修改用户偏好。新调度器初始化
只核对持久记录，不能同步等待自身重载事务；`startWhenReady()` 在成功回执之后开放其准入。
保存失败时新调度器保持停接，父 Run 等待关系保留，允许显式取消，不偷偷重派发。
仅更新已停用实现的缓存不创建活动目标意图，也不打开 gate。
保存结果不确定或卸载后失败沿用重启隔离与显式保持停用的恢复入口，不重放 Run/Tool。
`snapshot().codeReload` 随现有管理 API/SSE 提供稳定 code 和 Entry IDs，不返回源码或原始错误。

HMR 的最小框架扩展固定于 `@deepseek-ai/cordis-plugin-hmr@1.0.17`，源码、运行产物和类型补丁
保存在 `scripts/patches/`。安装、构建、类型检查都会应用补丁；版本和文件摘要不匹配时拒绝继续，
升级 Cordis 后必须重新核对接口及生命周期验收，不允许仅手改 `node_modules`。
Boot 会核对框架协调接口版本 3，缺少补丁时拒绝启动，不能通过跳过安装脚本退回无保护重载。
补丁安装器支持精确摘要匹配的前一补丁版本升级，其余未知改动仍拒绝覆盖。
验证入口为 `npm run test:code-reload` 与 `npm run test:managed-code-reload`。后者覆盖真实管理
HTTP、同一 Run、停用偏好、并发文件修改、SSE 通知和保存失败后的新 Root 隔离恢复；不等于
强杀进程后的残留锁恢复验收。这些验证使用本地确定性 Model Adapter 与临时目录，
`npm run test:stateful-code-reload:real` 另外覆盖真实 Wish 父/子 Run、tmux PID、Attempt、
Coordinator 状态、在途命令、多文件更新、激活失败及回执保存失败。不代表外部 Provider、
跨进程 Run 恢复或浏览器 UI 代码替换已经验收。

WebUI generation 切换会串行释放旧 Server，避免两个 generation 同时占用监听端口。
CLI 交互进程不承诺原地重载，配置变化后应退出并重新启动。

## Run generation 安全边界

`runEngine.open()` 创建稳定的 Core Runtime 与唯一 `RunGeneration`，执行实现按 Step 获取。
Host 可通过 `runEngine.execution.replace()` 等当前 Step 持久化收尾后替换 AgentLoop／Tool，
保留同一 Run、队列和取消状态。此入口不自行加载代码、不绕过能力撤销，也不是 HMR 开关。
Runtime 自身更新、关闭或稳定依赖丢失仍遵循退休流程：

```text
accepting
  -> retiring: 同步拒绝新 Run
  -> 每个活动 Run 只发送一次 abort
  -> 等待原 completion，不重放 Run 或 Tool
  -> retired
  -> 激活新 generation
```

排空期限由 Runtime 的 `generationDrainTimeoutMs` 控制，默认 30000ms。超时会以
`run_generation_drain_timeout` 使切换失败，但不会把旧代伪装成已排空，也不会放行新代。
未知 Tool side effect 必须通过显式 reconciliation 处理，不能由 HMR 自动重试。

## 验证

```bash
npm run typecheck
npm run test:permissions
npm run test:sandbox
npm run test:cordis-baseline
npm run test:cordis-boot
npm run test:cordis-config
npm run test:plugin-module-reload
npm run test:managed-config
npm run test:plugin-inspection
npm run test:cordis-lifecycle
npm run test:cordis-isolation
npm run test:run-generation
npm run test:step-execution
npm run test:tmux
npm run test:subagents
npm run test:subagent-tools
```
