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

## 内置 SearXNG Search

设置 `WISH_WEB_SEARCH_PROVIDER=searxng` 并提供 `WISH_SEARXNG_BASE_URL`，会装载
`web-search-searxng` Provider；对应 Tool 可用
`WISH_WEB_SEARCH_TOOLS_ENABLED=0` 单独隐藏。Provider 调用 SearXNG 的 JSON
Search API，由 SearXNG 聚合其配置的搜索引擎；搜索链路不需要第二个模型，也不会把主
会话上下文发送给搜索服务。

可选设置包括 `WISH_SEARXNG_LANGUAGE`、`WISH_SEARXNG_CATEGORIES`、
`WISH_SEARXNG_SAFE_SEARCH`（`0`/`1`/`2`），以及以 `WISH_SEARXNG_MAX_*` 和
`WISH_SEARXNG_TIMEOUT_SECONDS` 表达的请求限制。实例必须启用 JSON 输出格式。Provider
只访问配置的实例 endpoint、拒绝 redirect、不发送 Cookie，并且只接受有大小上限的
JSON 响应。
