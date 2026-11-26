# Web

Web 是外部公开信息能力，不是 `tools/basic` 的实现细节。本模块把两个可独立替换的
seam 放在同一顶层目录：

```text
WebSearch Definition -> Search Provider -> web_search Tool Consumer
WebFetch  Definition -> Fetch Provider  -> web_fetch Tool Consumer
```

`WebSearchService` 和 `WebFetchService` 拥有请求、显式 `resolve()`、不可变 Spec、
结果与错误契约。Provider 负责真实网络 IO；Tool Consumer 只负责模型 schema、
`web.search`/`web.fetch` 权限声明和模型可见结果渲染。

## 权限边界

- Web 调用必须声明 `effects.openWorld: true`。
- `web.search` 按 Search Provider 身份授权，不按每条 query 生成长期规则。
- `web.fetch` 按 Fetch Provider 与 URL origin 授权，不把完整 URL 作为长期规则身份。
- Provider 必须在 IO 边界验证 Core 签发的一次性 Grant 和当前 policy generation。
- `network.connect` 仍只描述 Shell 子进程网络；它不授予进程内 Web Provider 权限。

## 生命周期

Tool Consumer 只注入对应 Definition。Provider 缺失时仅对应 Tool 保持 pending；
AgentLoop 不直接依赖 Web。Provider 替换会让 Consumer 卸载并重新注册 Tool，因而使
Tools Registry generation 改变；旧 Step 不会静默切到新 Provider。

## 非目标

当前 Web seam 不包含浏览器、Cookie、登录态、页面交互或任意 Socket 代理。

## 内置 Web Fetch

公共 HTTP Provider 默认关闭。设置 `WISH_WEB_FETCH_ENABLED=1` 装载
`web-fetch-http` Provider；对应 `web_fetch` Tool 默认随 Provider 装载，也可通过
`WISH_WEB_FETCH_TOOLS_ENABLED=0` 单独隐藏。可选限制：

- `WISH_WEB_FETCH_MAX_REDIRECTS`
- `WISH_WEB_FETCH_MAX_URL_LENGTH`
- `WISH_WEB_FETCH_MAX_RESPONSE_BYTES`
- `WISH_WEB_FETCH_TIMEOUT_SECONDS`

内置 Provider 只接受 HTTP/HTTPS，不发送 Cookie 或环境凭证，固定 DNS 解析出的公开
地址，同源跳转逐跳重新解析，并拒绝私网、混合公私网解析、压缩响应和非文本内容。

## 网页搜索

在「设置 → 网页搜索」填写 DeepSeek 搜索 API 密钥并启用。
它使用独立 Search API，不要求主 Agent 使用 DeepSeek 模型，也不调用额外的聊天模型。
请求只发送 query、结果数和 `need_content: false`，结果适配为统一的来源列表。

`web-search` 是稳定的搜索插件身份，具体服务商由 `web-search.provider` 配置选择；
目前只支持 `deepseek`，设置页显示实际使用的 DeepSeek Search API。
`providers/search.ts` 负责插件生命周期和服务商装配，`providers/deepseek-search.ts` 负责 DeepSeek 请求协议。

`web-search-settings` 拥有配置命名空间，`web-search` 提供网络能力，
`web-search-tool` 向 Agent 暴露统一工具。配置保存在独立 Settings 文档中，服务停用时
仍然可以编辑。启用、停用使用受控插件操作；配置与启停偏好都在重启后恢复。
DeepSeek 参数保存在 `web-search-deepseek` 命名空间；它是服务商配置，不是插件名。
保存参数后下一次搜索使用新值；已经发出的请求继续完成，尚未执行的旧 Spec 在配置变化后
被拒绝，不能沿用旧授权。已保存启用偏好但缺少密钥时显示「待配置」，不会阻止 WebUI
启动；保存密钥后即可使用。未配置时调用工具返回配置缺失错误，不发起网络请求。

密钥通过 Credentials 只写保存到 `WISH_DEEPSEEK_SEARCH_API_KEY` 引用，不写入 Settings，
不回显，也不覆盖模型使用的密钥。请求发出前按引用读取；启动环境提供同名密钥时页面只读。
地址固定为 DeepSeek 官方 Search API，禁止重定向；查询最多 128 个 Unicode 字符，结果
最多 50 条，响应大小与超时可在设置中调整。错误不回传上游响应正文或密钥。
CLI 可用 `WISH_WEB_SEARCH_PROVIDER=deepseek` 与 `WISH_DEEPSEEK_SEARCH_API_KEY` 启用。
`WISH_WEB_SEARCH_TOOLS_ENABLED=0` 只隐藏模型工具入口；WebUI 保存的启停偏好覆盖默认值。

验证：`node scripts/accept-web-search.mjs`、`node scripts/accept-web-search-settings.mjs`，
浏览器验证为 `node scripts/accept-web-search-settings-browser.mjs`（均先 build）。
