# Browser Client

`npm run webui` 默认且唯一提供本界面，主界面以会话为中心并按轮次组织过程。这里只保存浏览器当前知道的
状态和 UI 状态，Session、Run、Todo、Goal、Plan、Workflow、Settings 的规范事实仍由 Host
所有者维护。

```text
Host API / events -> connection -> React-free Client Models
                              -> projection / module UI adapters -> slots -> React
```

- `connection.ts` 拥有 HTTP、CSRF token、管理 SSE、重连与 AbortController；不是全局业务 store。
  浏览器 offline 立即撤销可用状态与旧观察；online 先重新 bootstrap 取得 Root 代次，不重放
  写请求。旧 EventSource 的迟到通知不能覆盖新连接。断开观察不取消 Host Run。
- `model/` 保存稳定不可变快照；RefreshQueue 合并失效通知、淘汰旧选择或关闭后的结果。
  Session 镜像规范历史；Run 按游标去重，32ms 合并增量，最多保留 2048 条且约 4 MiB 事件。
  窗口过期明确展示缺口并重读规范历史，不自动执行工作。选中 Session 每 3 秒重新核对。
- `projection/ledger.ts` 先将规范 transcript 与 live 输出连接，规范结果优先，Tool 用 callId
  连接输入/输出；再投影为请求、过程与最终回答。运行时过程保持展开并更新同一 Tool 行，完成后
  最终回答成为主内容，过程就地折叠；工具参数和结果进入当前会话的只读“工具调用”子页面，不生成第二份可写任务状态，也不恢复聚合“执行记录”或原始事件流“执行轨迹”页。
- `slots.ts` 只管注册身份与 disposer：工作区/设置面板、导航、交互区域、通知、会话底部状态位、通用会话 ledger 贡献、按 Tool name keyed
  renderer、模块分类元数据及面板导航请求。未知或已卸载的 renderer 回退通用文本，保留
  历史。Host Tool Entry 可用状态独立绑定，未注册 renderer 不等于能力停用；断线时状态未知。
  面板可声明 `navigation: "rail"`，将入口贡献到最左侧全局导航而非当前区域的业务视图列表；
  `navigation: "hidden"` 只允许显式流程打开，不出现在区域视图列表，当前用于新建会话和主会话标题栏打开的“工具调用”；
  主会话是工作区默认本地面板，但单一面板不会在侧栏生成冗余入口；点击会话显式回到主会话，“工具调用”只从主内容顶部进入；
  `Sidebar` 可替换当前侧栏内容，`onOpen` 在进入面板前更新所有者自己的展示选择。
  三者随同一面板注册/清理；Shell 不按模块名分支，也不持有 Session 或归档状态。
- `plugins.ts` 提供静态贡献绑定与独立的 Tool 可用状态绑定；`module-loader.ts` 负责按版本
  加载可选 UI 模块，再以明确 Host Entry 身份、同一 Root 代次及实际 active 状态挂载。
  断线/停用撤销旧 UI 贡献，不等待在途下载；迟到导入不能恢复已撤销的能力。Host 插件没有
  UI Consumer 时不产生虚假面板。UI 代码清单不是 Host 授权来源。
- `main.tsx` 只装配常驻连接、Client Models、会话/管理界面与模块加载器；业务 UI 清单是
  `scripts/build-webui-client.mjs` 的入口地址、导出名和 Host Entry 声明，不集中导入实现。
  新增模块仍在自己的 `consumers/webui` 实现；Shell、Conversation 不出现模块名称分支。
  React 只接收 model 或 snapshot，不拿 ctx/transport。
- `ui/drafts.ts` 属于会话展示插件，草稿按 Session 留在当前标签页，切换页面不丢失；不是
  Host 历史或持久保存。迟到发送回执不能清掉发送后新输入的文字。
- `ui/sessions.tsx` 负责紧凑会话行、三点菜单、双击/F2 行内重命名与两类会话侧栏。
  当前会话的完整轮次索引仍作为会话内导航显示，不是独立工作区页面；点击较早轮次时按需扩展正文窗口后定位。
  删除使用一次原生确认；没有常驻管理卡片。重命名、归档、取消归档、删除均调用
  Session Client Model，再由 Host 执行。模型保留完整列表，普通导航只投影活动会话；归档
  通过全局导航进入，替换整个侧栏列表并在主区显示归档会话的只读聊天，不混入普通会话和业务导航。
  `model.browse()` 只切换浏览范围，分别记住活动/归档的选中会话；没有归档时显示归档空态，
  恢复或删除后选中同类下一会话。切换不取消 Host Run。两份列表复用 `projection/sessions.ts`，按精确的 Host `Session.scope`
  分组，目录末级同名时展示完整路径，不维护第二套 Workspace 状态。
  归档历史只读；归档不清草稿，成功删除才清对应草稿。变更期间淘汰过期列表响应，
  切换选择同时清旧历史与运行观察，不重放失败的写操作。
- 每次进入或刷新 WebUI 都从“新建会话”视图开始；已有会话仍列在侧栏中，只有用户点击对应会话才进入其主页面。显式导航优先，Shell 不判断会话业务状态。入口是页面中央的工作区选择卡片；选定后才显示首条消息输入区，不直接创建 Host Session，也不伪装成执行记录。
  `model/new-session.ts` 是 React-free 的创建意图与发送状态模型，`ui/new-session.tsx` 只从已有 `Session.scope` 投影近期候选，不把 Host 启动目录当成默认选项；目录末级同名仍展示完整路径。没有候选时点击选择入口直接打开 Host 目录浏览；无需手填路径。浏览模型在
  `src/workspace/consumers/webui`，只管理对话框导航与过期请求，Host 的只读目录列出在
  `src/workspace/directory-picker`，不混入 Workspace Step Snapshot 或 Session 事实。
  目录浏览使用管理令牌保护的 POST API，只列文件夹，至多返回 500 项并提示截断；隐藏
  目录默认不显示。未指定目录的浏览从 Host home 开始，但不预选 Workspace。用户选择工作区并发送首条消息时才把 `workspaceRoot` 发送给 Host，Host 重新校验目录。首条消息发送失败时
  草稿留在已创建会话，界面要求核对，不自动重复创建或发送。
  切换到已有会话或离开创建流程不会留下空 Session。候选列表只是浏览器读投影，不是第二套
  Workspace 注册表，Workspace 的规范身份与文件边界仍由 Host Workspace 能力所有。

Settings 描述与 Client Model 位于 `src/settings`；审批 Client Model 和 UI 位于
`src/approval`。工作区不提供 Plan、Memory、Tasks、Workflow、Context、Subagents 或执行轨迹的独立页面；
这些 Host 能力及 Session Feature 状态不因此删除。Todo、Goal 按需贡献主会话卡片，System Prompt 的最新快照位于主会话顶部，Subagents 与其他 Tool renderer 只在“工具调用”子页面展开完整调用证据。
tmux 不占用独立工作区页面，而是作为模块功能贡献到当前会话的通用右侧栏。Skills 声明全局左栏入口，并用自己的 React-free Client Model、目录侧栏
与正文视图替换默认会话导航；目录仍由当前 Session 的 Host Workspace 决定。Models 声明设置区入口并拥有自己的 React-free
Client Model，连接公开 Settings 描述、按模型上下文覆盖与脱敏 Credentials 状态。密钥输入只写
后立即从浏览器模型丢弃，快照永不持有原值。通用设置依次展示 WebUI 外观和 composer 命名空间；
Models/Pricing 另以独立 Host gate 向会话右下角贡献累计缓存命中率；Conversation 只渲染
通用 `sessionStatus` seat，不导入或解释 Models DTO。没有已完成 attempt 时该 seat 不占空间；
详情中的“部分”表示 Provider 字段覆盖不完整，而不是把未知缓存量计为零。
System Prompt 历史同样使用独立 Host gate，并通过通用 ledger contribution 提供请求时只读快照；
Conversation 不导入提示词 DTO，只把该贡献的最新快照放在主会话顶部；提示词历史仍保留在 Host 数据中，但当前 UI 不再把它混进聚合记录页。
首次有效快照和内容变化分别显示折叠行，正文只在展开时挂载；禁用 UI Consumer 只撤销展示，不删除后端历史。
`theme.ts` 只把 Host Settings 快照投影为根元素的主题、语言和字号，不另存一份偏好事实。
各模块 UI Consumer 提供自己的英文文案，Shell 不按模块 ID 翻译；会话正文和工作区文件保持原文。需要操作 Session Feature 的专用界面
只转发显示过的 token/action/feedback；过期确认必须重查。
Todo 模块只显示当前 UserTurn 的整表进度；Goal 模块显示持久 phase、进程内 activation、
轮次及带 revision 的人工操作。浏览器不生成自动 Goal round，也不把 UI 快照当作授权来源。
没有 Runtime 状态迁入 React，也没有在 Tools 下集中实现这些业务能力。

SessionFeature 的可选 `data` 是模块拥有的只读展示投影；Apps 只传递，不解释字段。
Subagents UI 用真实子记录身份及 parentRunId 关联 `spawn_agent` 调用，行内展开任务、持久
状态与终端快照；持久记录明确不代表实时进程状态。tmux UI 位于当前会话右侧栏，只列当前 Workspace 所属任务会话；侧栏仍由 Apps 提供通用功能容器，tmux 模块只拥有自己的 seat 与只读内容。
任务观察可显式刷新快照、查看采集时间和复制真实 attach 命令，不提供网页输入、启动或终止。
独立的 Workspace Files 模块通过只读 query control 浏览 Session workspace；独立的 User Terminal
模块才提供懒加载 xterm 的逐键输入、启动、resize 与关闭，并在创建时由 Host 固化 Session 权限和 Shell sandbox；
Files 使用单列可展开树；Terminal 通过有界 SSE attachment 接收原始 PTY 输出，输入和 resize 携带当前 attachment identity，
后台 roster 核对不传画面、不切换 loading，也不重建 emulator，
不把 tmux 观察入口升级成隐式执行 authority。历史 Tool 在 Host 入口确认不可用时标注并可前往插件管理，不删除历史正文。

CSS/HTML 无内联执行；浏览器 bundle 不携带 Node Provider 或密钥。当前正文以安全纯文本显示，
不加载远程内容。`client.js` 仅导入带版本的 core 入口；esbuild 的单一 ESM splitting 图共享
React/Cordis 运行库，业务模块不是各自打包一份 React。
最左侧工具栏固定，包含会话、归档、可插拔的 Skills 与设置入口；无顶部横栏，Wish/区域标题和收起按钮位于侧栏内。连接状态是 W 右下角
的蓝/红点，同时提供文字 tooltip 与读屏状态，不常驻显示 Host 文案。
`Shell` 只在当前页面运行期保存布局呈现状态：桌面展开/收起偏好与手机抽屉分开，跨断点重置抽屉而保留桌面偏好；关闭或刷新页面后从新建会话和收起的会话右侧栏开始。HTML 在 React 首次提交前直接提供干净的 Wish 启动画面，不展示浏览器保留的上一帧界面。
收起后点击 W 展开，悬停或键盘聚焦 W 切成展开图标；侧栏收起不会卸载当前聊天或清空草稿。
手机抽屉从顶部展开，背景主区 inert，最左栏仍可导航；Escape、遮罩、选择会话或选择 Skill 关闭，
焦点不会留在隐藏侧栏内。布局偏好只在当前页面保留，不承诺刷新恢复。
菜单使用原生 Popover 顶层，不被侧栏滚动容器裁剪；方向键选择、Escape 关闭，触屏可从
菜单进入重命名。常规桌面按钮最小 32px，触屏会话操作保留 40px 点击区域。

## 界面代码更新

已启动的新版页面每 3 秒检查同源 `/assets/ui-modules.json`。仅修改业务 UI 后运行：

```sh
npm run typecheck
npm run build:webui-client
```

这条构建只生成 UI 资源，不重写 Host `dist` 插件；不需要开启 Host `CORDIS_HMR`。
Host 代码替换仍使用自己的受控生命周期，不能把 UI 重挂载当作 Host 更新成功。
构建先完成整个编译，再写带哈希的模块/chunk，最后原子替换清单。编译失败保留已发布版本。
静态服务仅允许固定资源和严格格式的本地模块路径，保留 CSP、nosniff 与 HEAD/404 语义。

- 模块代码变更：先下载/校验新导出，再卸载旧 Browser 插件、激活新插件；一次 slot batch
  发布完整结果，保留面板选择和既有导航次序。Session、Run 镜像、连接、草稿及无关面板实例不重建。
- 下载/激活失败：提示对应模块，尽可能保留原界面；错误不转成 Host 能力启用。渲染异常由
  单个贡献的错误边界隔离，其他入口仍可用；更新修复后的 View 会清除该边界错误。
- core、共享运行库或全局 CSS 变化：提示先保存草稿、再显式刷新，不混用两个运行库，也不
  自动刷新。Shell/连接/模型不支持自身原地换代。迁移到不同构建路径也可能改变 core 哈希。
- 模块自己的局部 React 状态不承诺保留；需连续保留的状态由模块独立的 Client Model 拥有。
  草稿仅保留于当前页面，刷新不是草稿持久化方案。UI 回装不回滚任何 Host 业务副作用。

构建保留旧哈希资源以服务仍打开的页面；部署时不可边运行边清空 `public/core`、`modules`、
`chunks`。旧资源清理应在确认旧页面不再使用后离线进行；浏览器 ESM 缓存也不能主动卸载，
长时间频繁开发更新可在保存草稿后显式刷新。这里不是远程插件下载或任意代码执行管理 API。

验证入口：`npm run test:webui-next`、`npm run test:webui-next:browser`、
`npm run test:module-boundaries`、`npm run test:webui-code-reload:browser`。
代码更新测试在临时副本修改真实 Skills UI 源码并重新构建，覆盖同页替换、草稿/选择保留、
编译/导入/激活/渲染失败、修复、真实 Skills 启停和 core 刷新提示。Host 尚未声明安全停用
的模块仍会拒绝停用，不通过前端隐藏绕过（例如当前 Plan Provider/Consumers）。
浏览器验收使用隔离临时目录、随机本地端口、本地 HTTP
模拟 Provider 与真实 tmux；可设置 `WISH_WEBUI_CAPTURE_DIR` 保存截图与布局测量。
需要预装 Chromium（`npx playwright install chromium`）及所在系统的浏览器运行库/中文字体。
测试不会以环境缺失静默跳过；外部 Provider、远程部署和多人并发不在此验证范围内。
