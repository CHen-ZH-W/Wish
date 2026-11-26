# Workspace Files

`WorkspaceFilesService` 为 WebUI 提供当前 Session 工作区的只读文件数据。
WebUI 控制适配器从 `Session.scope` 取得根目录，Provider 通过 Workspace 解析真实路径，
并使用 Filesystem 的受保护路径策略限制读取范围。
目录列表和文本预览都有大小限制；受保护路径会被隐藏，绝对路径、`..` 和符号链接会被拒绝。

服务提供三个操作：`list` 列出目录，`read` 读取文本预览，`readBytes` 读取以 Base64 返回的文件字节。
这些接口用于人类查看文件，不授予模型工具权限，也不提供写入操作或保存另一份工作区登记表。

浏览器侧显示固定的工作区路径工具栏和可展开文件树，刷新时保留已加载层级和展开状态。
点击文件会通过 `openResource` 打开文件资源，由独立的 `document-preview` 模块负责展示。
Workspace Files 提供目录和文件数据，具体文本、图片及文档的预览渲染归预览模块负责。
