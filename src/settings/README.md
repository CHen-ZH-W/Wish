# Settings

用户设置能力，与部署用的 Cordis profile、插件生命周期和领域状态分开。
`Settings` 管命名空间、字段校验、默认值／装配 base／用户覆盖的解析及提交通知；
`SettingsStore` 管原始文档；`SettingsService.register(owner, definition)` 将贡献绑定到真实
Cordis owner。停用贡献者会移除设置入口，但不删除已保存值。恢复注册重新读取保存值。

设置页只能查看、修改已注册命名空间。首版支持有限的 boolean、number、string、enum
字段，不支持密钥、任意 JSON、部署表达式或可执行代码；API key 由独立 Credentials seam
只写保存，Settings 描述和文档都不会携带其值。
每个模块声明字段和 `applies: live / next-request / restart`，必要时提供纯校验函数。
Settings 不执行模块重启，也不把“已保存”伪装成“已经在当前 Run 生效”。

大枚举用于 Host 已验证的模型清单，最多 2048 项。声明 `allowStale` 的枚举在模块更新后可
保留已不在新清单中的旧存储值，供 UI 明确提示并修复；新的写入仍必须命中当前选项，不能
借此提交任意值。枚举选项可以附带有界、Browser-safe 的 label/attributes，供模块自己的
专用 UI 投影；Settings 不解释这些事实。`hidden` 字段可承载模块自己的安全公开状态，通用
编辑器不会展示。由模块决定旧值的运行时回退策略。

`replace({ namespace, revision, user })` 整体替换该命名空间的用户层；未给出的字段重新继承。
版本在实际串行写入前检查，旧编辑器拒绝覆盖新值。写请求在排队前复制；保存成功后才更新
解析值、发送 `committed` 通知。通知不携带值，观察者异常不逆转提交。注册代次在写入完成
前不能被替换，避免旧写入使新 owner 缓存过期。旧 scope 在 owner 关闭后拒绝读取。

文件 Provider 保存独立 JSON 文档，0600 文件、同目录临时文件、rename 和 fsync；整个打开
期间用独占 lock 排斥第二个写进程。不借用业务 Storage，因此 Storage 停用不撤销管理持久化。
外部文档版本变化要求重新加载，不自动覆盖。rename 后同步失败为 `settings_save_uncertain`，
禁止继续写入，不能按普通失败自动重试。进程崩溃的残留 lock 不按 PID 自动偷锁：先确认旧进程
确已退出、备份并核对该文档和 lock，再由操作员移除该文件的确切 lock，重启读取。

插件启停走 `boot/plugin-control` 的受控操作，不注册一个布尔设置绕过准入和清理。
前端 Settings 外壳消费公开描述；需要独立入口的模块由自己的 Browser UI Consumer 选择
命名空间并贡献面板。Shell 与 Settings 服务都不包含模块名称分支。
通用编辑器没有刷新、保存、重新加载或用户层重置按钮：boolean/enum 选择后立即提交，文本
与数字在结束编辑时提交，邻近状态说明提交中、已应用或错误。Host 失效通知仍会自动重读权威
快照；CAS 冲突不会静默覆盖另一编辑器。
WebUI 的 `webui-appearance` owner 提供浅色／深色主题、中文／英文界面和标准／大／特大字号，
排在 `webui-composer` 消息输入之前；选择仍通过同一 Settings 持久化和 revision 校验，
Browser 只负责应用已确认的公开值。语言只作用于界面文案，不翻译会话、工作区文件或 Host 原始数据。

验证入口：`node scripts/accept-settings.mjs` 与 `node scripts/accept-credentials.mjs`（先 build）。
