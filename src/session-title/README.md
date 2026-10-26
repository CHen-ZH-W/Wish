# 会话标题

会话标题模块从已接纳的首条用户输入创建可读标题。`session-title-session-feature` 接收
Application 的 Run 接纳通知；只有明确的 `user` 来源会触发命名，续跑、未知来源和子任务
不会被当成人类首条输入。CLI 已有的截断标题和旧记录标题按手动标题保留。
Consumer 绑定默认 Session graph；使用 `Application.open({ dataDirectory })` 打开的其他
数据根跳过这组标题钩子，不会凭相同会话 ID 修改默认数据根。标题插件卸载后释放可选清理
注册，不阻止主 Run 清理或会话删除。

## 职责

- `TitleController` 负责兜底、任务去重、并发限制、超时、重试和结果验收。
- `SessionTitleGeneratorService` 是可替换的生成接口，`session-title-model` 提供模型实现。
- `session-title-storage` 通过 Storage Backend lease 保存 `session-title/jobs` Domain。
- Sessions 保存展示标题、来源与独立修订号；模型结果通过 `expectedTitleRevision` 原子提交，
  不写入 transcript，也不改变 `historyRevision`。

默认路径先落盘首条文本的开头作为兜底，最多 60 个 Unicode 码点、120 个 UTF-8 字节，
再保存后台任务。`accept()` 只等待本地状态提交，不等待模型。默认 Provider 读取运行引擎的
活动 Run 快照；只要仍有前台 Run，任务就保持排队，不占用标题请求槽位、不消耗尝试次数，
每 250 毫秒重新检查一次。首轮主会话结束后才允许发出标题模型请求；持续的前台工作会
继续推迟标题，兜底标题始终可用。WebUI 的会话轮询会读取后台提交的标题，主 Run 的连接
结束后仍可更新；创建和发送成功后的页面切换不等待全量会话刷新。

## 生成与失败

生成请求只包含标题专用指令和有大小上限的用户文本，不加载主对话、工具或工作区内容。
输入在 JSON 包装后受 4096 字节预算约束，长中文、代码和引号会按实际编码大小裁剪。
输出只有在成功终止并通过检查后才提交；推理文本、工具调用和不完整输出不能成为正式标题。

默认优先关闭模型支持的推理。不能关闭时，可选择同 Provider 配置中的非推理模型；显式
配置的模型路由不会被替换。无合适替代时保留原路由并使用较大的输出预算。模型 token
用量保存在标题任务中，不伪造主 Run 的调用身份。

每个会话只有一个首条输入任务，全局默认最多一个标题请求。一次尝试默认 20 秒，最多
三次尝试，重试间隔指数增加；网络、限流、服务端错误、超时和可恢复的空结果可重试。
鉴权、配置、输出预算和工具调用错误终止生成并保留兜底。后台任务的并发上限独立于
主模型请求，同一 Provider 的配额仍可能共享。等待前台结束只约束新标题请求的启动；
若标题已经在途，随后开始的新 Run 仍可能与它共享配额，这不是 Provider 资源的强隔离。

超时会先记录失败或下次重试并发出取消信号，但实际 Provider 调用结束前仍占用并发槽。
关闭服务也等待这些实际调用结束；Provider 必须响应取消，忽略取消且始终不结束的调用
会继续占用槽位并阻止排空，不能被视为已经停止。

手动重命名和手动清空标题都保留 `manual` 来源，并取消旧请求。提交前还会核对 Session
状态与标题修订，迟到结果不能覆盖手动改名。归档取消任务，删除清理任务。关闭服务取消
并排空已启动工作；任务状态、尝试次数与重试时间持久化，启动时核对中断任务并保留预算。
File Backend 的 CAS 只保证单进程写入，同一数据目录不支持多个 Wish 进程并发写入。

若进程在兜底标题提交后、任务提交前退出，恢复时会从 transcript 首条明确标记为人类
`user_input` 的记录重建任务。若输入尚未归档或没有可用的可信文本，只能使用已保存的
截断兜底作为种子，无法还原原文和丢失的显式模型路由。启动协调可暂停任务接纳，先恢复
持久状态，再在运行环境就绪后放行生成。
前台优先检查读取当前运行引擎，不依赖标题插件内保存的 Run Promise；标题插件局部替换
后仍会等待原有前台 Run，真正进程重启后则按恢复后的运行状态重新判断。

诊断事件仅记录会话标识、状态、尝试次数、错误码、耗时、模型路由和 token 用量，
不包含用户文本、标题原文、模型错误原文或凭证。

## 配置与验证

默认 Cordis Profile 在 WebUI 装配生成 Provider、存储 Provider 和 Application Consumer。
三个入口归属于独立的 `session-title` Group，保留原有 Entry ID；只有 `sessionTitle` 和
`sessionTitleGenerator` 在组内隔离。公共 Sessions、Models、Storage、Runtime 和 Application 从应用
作用域继承，标题功能通过 Session Feature 注册贡献，不要求公共服务依赖标题实现。
新增或修改标题组只影响该组及其实际依赖，主业务实例保持不变；从旧应用级标题隔离布局
迁移到该布局属于应用结构变更，仍须经过完整收尾和恢复检查。
普通 CLI 保留截断标题，Help、Version 等命令不会接管 WebUI 的待办标题请求；CLI 可显式设置
`WISH_SESSION_TITLE_ENABLED=1` 装配模块，内部 child 入口始终关闭。
`WISH_SESSION_TITLE_ENABLED=0` 可关闭 WebUI 自动标题；`WISH_SESSION_TITLE_MODEL` 可指定已配置的
`provider/model`，`WISH_SESSION_TITLE_TIMEOUT_MS` 和
`WISH_SESSION_TITLE_MAX_OUTPUT_TOKENS` 可调整请求预算。其余限制可在各插件的 Loader
配置中设置，模型密钥继续由 Models 管理。

`npm run test:session-title` 构建并检查元数据 CAS、任务调度、模型生成器、真实 HTTP
Application 入口与默认 Cordis 接线。测试使用确定性模型，不代表真实 Provider 或浏览器验收。
`npm run test:plugin-hot-update` 另检查旧业务图到新标题组的在线升级、局部替换、失败回滚和
重启后的显式恢复，使用临时数据，不修改用户的运行目录。
