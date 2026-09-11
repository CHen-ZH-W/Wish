# Boot

`src/boot/` 是 CLI 与 WebUI 共用的进程启动层。它只负责创建 Cordis Root、提供启动事实、
加载配置树、转发进程信号和回收进程资源；Session、Model、Context、Tool、Runtime 等业务
能力仍由各自模块拥有。

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

同一个 Include/EntryTree 中的 `id` 必须全局唯一。配置应使用带能力或隔离域前缀的稳定
ID，避免 Loader 把同名条目误判为移动或更新。

## 默认依赖图

默认 profile 在私有 `app` realm 中按依赖关系组合：

```text
sessions
models <- model adapter plugins
contextEngine + compaction
tools <- read / write / edit / grep / bash plugins
agentLoop
runEngine
agents
application
cli | webui
```

Root 只共享 `launch`、Loader、Timer 和 HMR 等进程基础设施。`BootstrappedProcess.context`
始终指向 Root；`surfaceContext` 指向目标 surface 所在的隔离 realm，用于访问该业务图。
同一 Root 可以承载多套同名业务 service，而不会共享 Session、Registry、Agent 或 Runtime
配置。

每个插件拥有自己的 Schemastery 配置：

- Sessions：数据目录；
- Models：配置来源、默认模型、fallback 与重试次数；
- ContextEngine / Compaction：各自的预算；
- Runtime：Step 上限与 generation 排空期限；
- Agents：Agent ID 与 instructions；
- WebUI：host、port 与 workspace root；
- Application：不重复声明上游业务配置。

CLI 的显式参数作为 surface override 传给 Application，不改变字段的 service 所有权。

## 生命周期与重载

CLI 的执行 Promise、Terminal 和 signal subscription，以及 WebUI Server 的异步 setup，
都由对应 Cordis fiber 的 effect 持有。依赖消失时 consumer 进入 `PENDING`；依赖恢复后以
新的 service generation 激活。Root dispose 会回收信号监听、终端和 Server。

默认关闭 HMR。设置 `CORDIS_HMR=1` 后，默认 profile 会启用配置监视。合法 stable-ID
更新会替换对应 generation；无效更新清理失败尝试并回滚到 last-known-good 配置；
`disabled` 会卸载目标 fiber。

WebUI generation 切换会串行释放旧 Server，避免两个 generation 同时占用监听端口。
CLI 交互进程不承诺原地重载，配置变化后应退出并重新启动。

## Run generation 安全边界

`runEngine.open()` 为每份不可变依赖图创建唯一 `RunGeneration`：

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
npm run test:cordis-baseline
npm run test:cordis-boot
npm run test:cordis-config
npm run test:cordis-lifecycle
npm run test:cordis-isolation
npm run test:run-generation
```
