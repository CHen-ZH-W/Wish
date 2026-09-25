# 插件增删改实施记录

本轮交付：为 Wish 业务插件补齐受控增删改的主干、公共适配协议、真实依赖传播、
安全点、失败恢复与覆盖检查。业务状态归各领域，Cordis 维护动态绑定和生命周期，
Host 只协调准入、排空、配置、回执和恢复。

普通插件不得以统一标记重启代替清理适配。现有第一方 managed Owner 已完成同进程停用和
代码换代；restart 仅保留为外部／旧插件的兼容诊断，不能通过 managed 覆盖门禁。

## 当前目标步骤

1. 显式 Kernel/managed/structural/noncompliant 分类与失败型覆盖门禁：已完成。
2. 合并 Owner Registry：已完成。生命周期与代码更新不再各自保存声明；完整 Owner 一次登记
   `status + prepare(change) + replacement`，旧 API 只作同一记录上的兼容贡献，冲突 fail closed。
3. 统一 `PluginChangeCoordinator`：已完成。UI 启停、配置文件重载、原生 HMR 与独立 stop 都由
   Root 上同一个协调器授予顶层变更身份，并复用同一 scope 完成停用子流程；阶段只能按
   `preflight → waiting-safe-point → fencing → draining → staging → switching → retiring → verifying`
   前进，最后落为 succeeded/rejected/recovery-required。
4. 持久异步 operation：已完成。Host 在执行前持久接纳并返回 operationId；四类入口进入同一
   FIFO 队列，阶段、目标和终态写入 v2 journal，可独立查询并按阶段取消。浏览器/调用方超时
   只结束等待，不撤销已接纳工作；重启不重放副作用，而把未完成 operation 确定归为
   rejected 或 recovery-required。v1 状态原地兼容迁移且不改变配置 revision。
5. 统一安全变更事务：已完成。启停、配置与代码替换都区分“尚未改变”“已验证恢复旧代”
   和“无法证明恢复”三种失败结果；只有旧配置／模块回调被保留、候选代已完整清理且旧代
   重新激活并通过 Owner/Fiber/持久状态核验时，才清除 pending 并记录 rolled-back 拒绝回执。
   清理超时、清理异常、提交结果不确定或恢复核验失败继续进入 recovery-required，不做盲目反向操作。
6. 现有 restart 业务 Owner 迁移：已完成。Approval/Models/Agents/Application、CLI/WebUI、
   Session/Storage/Workflow、Runtime 与 Runtime Journal 均登记真实 drain 或 generation 协议；
   Runtime 执行边界不再把自身伪装为 restart。Agents/Application 只封住旧 factory/facade
   引用，Run generation 由 Runtime 创建并由实际消费它的 CLI/WebUI 退役，避免双重清理。
   managed Fiber 的配置更新按 UID 串行，轮到执行时先等待依赖传播中的代际稳定，避免
   Provider 与 Consumer 同时更新形成 epoch ABA。
7. 最终 UI 与第三方 manifest/spec：已完成。Host 输出逐 Entry 的 enable/disable/replace 权威；
   Kernel/structural 灰色只读，noncompliant 黄色警告。Catalog 外部代码必须通过
   `wish.plugin/v1` manifest 的 API、入口、Config、权限/Sandbox、替换和状态校验才能成为
   managed；运行时 Owner 覆盖与替换模式再次核验。
8. managed compatibility 路径清理：已完成。Sessions、Session File、File Storage、Workflow
   Continuations/Storage/Schedulers、Subagents Runtime、Local tmux 与 Memory Curation 已改为
   单次 canonical Owner 声明；Host 在 stop、配置变更和原生 HMR 的副作用前拒绝由旧
   lifecycle/code-reload API 拼接的 compatibility 记录。旧 API 仅保留给非 managed 的独立
   兼容测试／嵌入，不再能通过 managed conformance。
9. 最终验收矩阵：已完成。当前真实 WebUI 装配中所有 Host 允许操作的 managed Entry 均完成
   100 次整图批量停用／重新启用，并额外逐项完成三轮独立循环；至少 50 个 Entry、累计至少
   5,150 次 Entry 换代。每轮核对活动 Entry/Fiber、Owner 声明、Tool、Cordis effect、Storage
   lease、监听器、定时器、物化句柄、子进程、有效 FD 与 inotify watch 回到启动基线。该门禁
   发现并修复了 Memory Curation 延迟释放 Storage lease、code reload 一次性启动 effect 残留，
   以及 Models settings 被错误绑定到调用方 Fiber 三项所有权问题；忙碌态专项与
   fencing/draining/switching 真实崩溃矩阵也均已通过。

operation journal 与业务 pending/receipt 共用原子串行写通道，但 operation
阶段更新不推动配置 revision；副作用一旦进入 fencing/switching 就不可取消，回滚也只恢复
受协议管理且可核验的插件代次，不声称撤销任意外部业务副作用。

| 关卡 | 内容 | 验证与实际范围 |
| --- | --- | --- |
| 0 | 基线与清单 | 原有 9 个脏文件保留；新增 CLI/WebUI 真实装配覆盖验收，所有活动 Wish 业务 Fiber 必须登记生命周期与代码更新策略；原生 Loader/Include/Group/Timer/HMR 仍属框架层 |
| 1 | 公共协议 | `PluginWorkOwner`、`ManagedToolOwner`、Context 与 SessionFeature 包装；11 项行为验收：准入、排空、取消等待、旧引用、流式调用、失败、提交后启动错误与一次性激活 effect 清理 |
| 2 | 基础工具和 Provider | Read/Write/Edit/Grep/Bash；6 项工具、5 项 Provider、5 项真实 HMR；Consumer 收尾完成后才关闭 Provider；20 项停用回归 |
| 3 | 上下文与知识模块 | Web/Skills/Memory/SystemPrompt/Context/Compaction 接入；包含后台扫描、证据来源、存储租约；Application 不再硬依赖每个 Step 的 Context/Compaction 实例 |
| 4 | 有状态模块 | Plan/Tasks/Coordinator 停用恢复后保留状态；Workflow/Subagents/tmux 真实更新与故障场景 8 项通过；批量初始化透传调用者作用域，父等待关系不提前释放 |
| 5 | 依赖与嵌套配置 | 50 项配置回归；原生 Group 增删改/移动/重排/类型转换及静态 managed Include；文件环、重复 ID、未命中 patch、无归属子 Fiber 拒绝；自定义 carrier 没有通用迁移协议，仍明确拒绝 |
| 6 | 操作协调 | 配置和代码更新共用 Step 安全点及串行入口；有界队列、requestId 去重、等待取消/超时、出队 revision 复查；开始清理后不可取消；8 项真实 HTTP/Run/HMR 验收 |
| 7 | 源码更新 | 内容不变的重写不触发 HMR；Provider 传输实现与 Models 注册表解耦；5 项基础工具、14 项领域/Provider/Context WebUI 真实文件更新测试 |
| 8 | 崩溃与恢复 | 12 项存储验收；SIGKILL 后只回收同 host/boot/PID namespace 中已死亡的锁；真实独立进程分别在 fencing、draining、switching 被杀，重启隔离且不重放激活/清理副作用 |
| 9 | 管理与扩展 | 页面显示声明覆盖、等待阶段与取消入口；外部 greeting Provider/Tool 示例使用公开 package exports，通过 required service 消失/恢复、旧引用与注册清理验收 |
| 10 | 历史集成基线 | 严格 managed conformance 门禁加入前，类型检查、构建、完整 npm test、真实 tmux 8 项、综合浏览器 6 项与浏览器专项 1 项通过；不能作为当前最终验收 |

## 验收记录

- `npm run typecheck`、`npm run build`、完整 `npm test` 与 `git diff --check`：通过。
- `accept-plugin-coverage.mjs`：CLI/WebUI 严格 managed conformance 2/2 通过，活动 managed
  条目的 `restart`、`incomplete`、`compatibility` 与 `noncompliant` 均为空。
- `accept-managed-core-owners.mjs`：共享 11 个核心 Owner 逐项停用／重新启用和原生代码替换，
  加 WebUI 入口独立停启／替换共 3/3 通过；检查旧 Fiber disposed、新 Fiber active 和 Root Host 存活。
- `accept-app-plugin-config.mjs`：4/4 通过；包含非法 Runtime 配置回滚后同时更新 Runtime/WebUI，
  新端口实际启动、旧端口关闭且 Session 数据保持。
- `node scripts/accept-stateful-code-reload-real.mjs`：8/8 通过，使用独立数据目录和 tmux socket。
- `accept-managed-tmux-drain.mjs`：真实 managed 停用在 Local tmux 命令执行中进入 draining；
  fence 后拒绝新命令，等待旧命令完成，再卸载旧 Fiber 并在同一 Host 重启新 Fiber。
- `accept-managed-subagents-drain.mjs`：Subagents 有在途 API 和活动子任务时进入 draining；
  旧请求完成后卸载 Runtime，子进程不被管理停用误杀，重启新 Fiber 后从持久记录恢复且不重复 spawn。
- `accept-managed-workflow-drain.mjs`：Workflow Scheduler 有在途 tick 和活动 Attempt 时进入
  draining；旧调度调用完成后卸载，持久 Run/Attempt、外部 child 和父等待不被取消，新 Fiber
  核对同一 child 且不重复 dispatch。
- `node scripts/accept-plugin-management-browser.mjs`：1/1 通过；真实 Chromium 检查覆盖提示、等待、取消、Read 停用与恢复。
- `accept-managed-idle-cycles.mjs`：1/1 通过；动态枚举真实 WebUI 装配中至少 50 个可操作
  managed Entry，每个 Entry 完成 100 次整图批量换代和三次逐项独立换代，累计至少 5,150 次；
  旧 Fiber disposed、新 Fiber active，且 Entry/Fiber、canonical Owner、Tool、Cordis effect、
  Storage lease、监听器、定时器、物化句柄、子进程、有效 FD 与 inotify watch 均无净增长。
  该测试已加入 `test:plugin-adaptation:built`。
- `accept-managed-crash-recovery.mjs`：3/3 通过；独立进程分别在 fencing、draining、switching
  的 durable operation 阶段被 `SIGKILL`，重启后一律保持目标隔离并归为 recovery-required；
  显式恢复收敛为 disabled，effects 日志证明 activation 与 cleanup 均未重放。
- `accept-external-plugin.mjs`：2/2 通过；覆盖 manifest fail-closed、class-only 不晋级、Config
  Schema、权限上限、状态版本兼容、Provider/Consumer 级联、旧引用、无重复 Tool、配置替换与
  replacement mismatch 回滚。
- `node scripts/accept-plugin-change-coordinator.mjs`：7/7 通过；覆盖持久接纳、FIFO、阶段单调、取消边界、
  recovery 持锁与 Root 关闭。`accept-plugin-managed-store.mjs` 12/12，包含 v1 迁移、真实 SIGKILL
  后的 operation identity 保留与重启终态归类；
  安全事务三种失败结果、独立 stop 20/20、managed 启停 10/10、配置回滚 50/50、原生 HMR 9/9
  与 managed HMR 10/10 均由对应验收覆盖。
- 综合 WebUI 浏览器：6/6 通过；旧测试的按钮文案与空会话入口选择器已按现有界面同步，保留业务断言。日志 `/tmp/wish-plugin-browser-final.log`。
- Chromium 使用已有 `/tmp/ggbot-browser-libs` 的动态库和独立字体配置；未安装或修改系统库。
- 没有访问真实外部模型 Provider、没有部署，也没有提交现有工作区改动。

## 明确边界

1. 默认 CLI/WebUI 业务图的活动 managed 条目均为 `stop: online`、`codeUpdate: online`；兼容
   restart API 仍存在，但没有第一方 managed Owner 使用它。
2. Runtime 创建并退役其 Run generation，CLI/WebUI 退役各自打开的 Application generation；
   Agents/Application 只管理准入和旧引用，不重复拥有同一 generation。短请求与 Journal 使用
   drain；Provider/Session/Storage 使用领域 lease 和真实 close，不迁移执行中的 JavaScript 调用栈。
3. 自定义 Group/EntryTree、原生 Group 下额外程序化挂载的迁移仍拒绝；普通插件自身的程序化子 Fiber 会进入真实依赖闭包，缺少协议就拒绝。没有声称无条件支持任何第三方代码。
4. managed Include 是受控的只读源码组合：全局唯一 ID，文件须已存在，单一 Host 写入意图/回执；不执行 Include.initial，也不保留多个独立 writer。
5. 无法证明安全的锁、收尾失败、清理／激活超时、提交结果不确定及旧代恢复核验失败均保留
   恢复要求。只有确定性候选失败且受控代次可完整重建时才回滚；并发数据库迁移、领域 schema
   升级与任意外部副作用撤销不在本轮自动处理范围内。
6. 外部 manifest 是静态准入和权限上限，不是可信执行沙箱或测试证书。v1 仅支持
   `trusted-in-process`；不可信第三方代码、Worker/子进程隔离和外部发布签名仍不在本轮范围。

## 当前严格覆盖结果

`accept-plugin-coverage.mjs` 同时检查 managed CLI 与 WebUI 真实装配；两者的 `restart`、
`noncompliant` 和 `incomplete` 均为空。覆盖结果来自真实 Owner/Fiber 登记，没有修改业务分类，
也没有把原业务条目改成 Kernel。后续新增 managed 插件如果缺少 stop 或 replacement，门禁仍失败。

实现说明：[插件管理协议](README.md)。扩展入口：[greeting 样例](../../../examples/plugins/greeting/README.md)。
