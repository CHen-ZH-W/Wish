# Boot

`src/boot/` 是 CLI、WebUI 共用的进程启动粘合层，不是业务能力插件目录。它创建 Cordis
Root、加载默认或外部 profile，并把启动事实交给配置树；各插件仍归属于 Apps、Sessions、
Models 等实际能力目录。Cordis 负责插件树、服务依赖、隔离、effect 生命周期和 HMR；
Wish 的 Run、Step、Session、ToolCall 等领域数据与不变量继续由对应模块定义。

当前启动代码只有 `bootstrap.ts` 与 `launch.ts`。默认组合位于 `config/cordis.yml`；CLI
和 WebUI 插件分别位于 `src/apps/cli/plugin.ts` 与 `src/apps/webui/plugin.ts`。后续能力插件
也放回它们自己的模块，不建立统一的 `cordis/plugins` 容器。

## T0：发布包基线

T0 只锁定并验证框架发布面，不改动现有 Apps/Core 组合：

| Package | Version |
| --- | --- |
| `@deepseek-ai/cordis` | `4.0.2` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.3` |
| `@deepseek-ai/cordis-plugin-include` | `1.0.7` |
| `@deepseek-ai/cordis-plugin-group` | `1.0.2` |
| `@deepseek-ai/cordis-plugin-hmr` | `1.0.17` |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.4` |
| `@deepseek-ai/cordis-plugin-logger-console` | `1.0.2` |
| `@deepseek-ai/schemastery` | `3.18.2` |

这些包直接使用 npm 发布产物并在 `package.json` 中精确锁版本；Wish 不复制 DeepSeek
Harness 的 `vendor/`。`node-addon-require-builtin@0.1.4` 同样被精确锁定，它是 Loader
访问 Node 内部 ESM loader、从而让 HMR 在普通 Wish 启动命令下工作的运行时配套依赖。

Wish 的 Node 基线是 `^22.19.0 || >=24.0.0`。Cordis Core 等包虽然可以在 Node 20
导入，但 HMR 明确不支持 Node 20；最高目标包含 HMR，因此不保留一个只能运行部分插件
栈的 Node 版本。T0 已分别在 Node 22.19.0、24.9.0 和 24.12.0 验证，覆盖 Node 24
内部 ESM loader 接口切换前后的发布包行为；开发和运行 Wish 前必须先切换到受支持版本。

运行 T0 验收：

```bash
npm run test:cordis-baseline
```

验收覆盖发布包与 lockfile 精确版本、ESM 导入、`inject` 的 PENDING/激活/释放、effect
回收、Context 隔离、Loader/Include/Group 的 YAML 组合、Schemastery 首次加载与更新
失败、stable id 更新、`disabled` 卸载与恢复，以及 Loader 管理插件的真实 HMR。完整
`npm test` 也包含这项验收。

同一个 Include/EntryTree 内的配置项 `id` 必须全局唯一；即使两个子项位于不同 Group，
也不能重复使用 `provider`、`consumer` 这类局部 id。后续配置使用带能力或隔离域前缀的
稳定 id，避免 Loader 把同 id 条目识别为移动或更新。

## G1：Cordis 拥有进程基座

G1 已把两个产品 bin 切到同一个 `bootstrap()`：bootstrap 创建唯一 Root Context、提供
稳定的 `launch` service、安装 Loader，并通过根 Include 加载随构建发布的
`cordis.yml`。CLI 与 WebUI 是配置树中互斥的 Loader 条目；入口不再装配 Application、
Server、Terminal 或信号处理器。

```text
wish / wish-webui bin
        └── bootstrap()
              └── Cordis Root Context
                    └── Loader
                          └── Include → cordis.yml
                                └── app Group
                                      ├── cli
                                      └── webui
```

当前两个 surface 插件是明确的过渡边界：它们仍复用 `createWishApplication()` 已验证的
内部组合，但 Application 只由 Loader 管理的 surface 插件触发，并由对应 fiber/effect
持有生命周期。Root dispose 会回收 CLI Terminal/信号监听或 WebUI Server；启动失败和
永久 PENDING 条目都会让 bootstrap 失败，并先清理已经启动的部分树。

运行 G1 验收：

```bash
npm run test:cordis-boot
```

该验收包含入口防绕过检查、Root/Loader/Include 真实装载、选定 surface 激活、PENDING
启动失败与部分 effect 回收、构建后 CLI 子进程，以及构建后 WebUI 启动、HTTP 请求和
SIGTERM 关闭。

## G2：真实配置与重载控制面

G2 把生产配置来源固定为以下优先级：

1. `bootstrap({ configurationFile })`；
2. `CORDIS_CONFIG`；
3. 随构建发布的默认 `cordis.yml`。

字符串路径相对 `launch.cwd` 解析；URL 必须使用 `file:`。Cordis 配置及其 `!!js` 表达式
和插件都能执行本地代码，因此外部 profile 是受信任的代码边界，不应加载来源不明的文件。
最终使用的绝对路径和来源分别暴露为 `launch.configurationFile` 与
`launch.configurationSource`，便于诊断而不重新读取环境。`argv` 与路径是启动快照；
`environment` 保留调用方提供的运行时引用，以便 Provider 在实际调用时读取凭据。

Root 为配置树注册 `include`、`group`、`timer`、`hmr`、`cli` 和 `webui` builtins。
因此位于任意目录的 profile 都能写 `cordis:group`、`cordis:cli` 等稳定名称，不需要在
profile 目录复制 Wish 或安装另一份 Cordis。默认 profile 使用 `app` Group 包住两个
surface；Group 更新失败会回滚到 last-known-good 子树。

模块 HMR 默认关闭。设置 `CORDIS_HMR=1` 后，默认 profile 会启用 HMR；自定义 profile
也可以显式配置 `cordis:hmr`。HMR 会监视 Loader 管理的 Include，在配置变化时调用其
事务性 refresh：合法更新按 stable id 生效；schema 无效时会清理失败尝试涉及的 generation，
用 last-known-good 配置重新激活，并通过 Root 的 stderr diagnostics 报告失败。
`disabled` 会卸载目标 fiber，Root dispose 会关闭 watcher、diagnostics 和剩余 effect。

运行 G2 验收：

```bash
npm run test:cordis-config
```

该验收覆盖显式配置覆盖环境配置、相对路径解析、无效路径 fail-fast，以及构建后真实
WebUI 进程从外部 profile 启动；随后在同一进程内验证有效更新、schema 无效回滚、
`disabled` 卸载、重新启用、HTTP 存活和最终清理。

## G3：配置归属于插件

G3 没有建立全局 config service，而是让 CLI 与 WebUI Loader 插件分别导出自己的
Schemastery `Config`。启动器只提供 `launch` 事实，不解释应用字段；配置树负责把对应
config 交给插件。具体字段、优先级与验收记录在 `src/apps/README.md`。

## 后续边界

G1-G3 已完成进程所有权、动态配置控制面和第一批 plugin-owned config，但不把这些
基础设施接入伪装成 Everything-is-Plugin 已完成。下一阶段才会把 legacy surface 内部的
Sessions、Models、Context、Tools、Runtime 和 transport 逐个提升为服务插件；
`createWishApplication()` 在这些能力全部迁走前仍是内部兼容组合。

HMR 只保证配置与 fiber 生命周期，不会替 Wish 判断业务恢复语义。更新会影响活动 Run 的
插件必须明确采用拒绝、排空或中止策略；未知状态的 Tool side effect 绝不能因为 reload
自动重放。
