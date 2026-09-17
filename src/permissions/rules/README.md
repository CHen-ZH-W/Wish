# ApprovalRuleStore

`src/permissions/rules/` 保存用户已经批准的精确 capability。它是 Permissions 拥有的
可替换 Cordis Service；
Permissions 是唯一的规则匹配和写入消费者，CLI/WebUI 只选择有效期，WebUI 另提供查看与
撤销入口。

规则只保存 `allow`，拒绝不会持久化。所有匹配同时绑定：

- Permission profile 与显式 policy version；
- Tool 名称与规范化 capability digest；
- Agent ID 与 Workspace fingerprint；
- 对应 scope 所需的 Run ID 或 Session ID。

Workspace `revision` 不进入长期规则身份；每次调用仍先经过当前 SandboxPolicy preflight，
因此仓库事实变化不会绕过当前 Provider 的执行边界。

## 四种有效期

- `once`：不进入 Store，只授权当前 Tool Call。
- `run`：仅在当前 Provider 进程内保存，并精确绑定 Run ID；`clearRun()` 可主动回收。
- `session`：通过 Storage Domain 持久化，并精确绑定 Session ID。
- `workspace`：通过 Storage Domain 持久化，对同一 Agent 和 Workspace 的后续 Session 生效。

匹配优先级为 `run -> session -> workspace`。规则只能复用相同 capability digest；命令、cwd、
timeout、路径、网络或 effect 任一变化都会产生不同 digest 并重新审批。

## 文件职责

- `types.ts`：scope、规则身份、记录与 Store Port。
- `errors.ts`：关闭后访问等规则错误。
- `service.ts`：Cordis `approvalRules` Service Definition。
- `store.ts`：Storage Domain schema、内存 Store 与 Domain Store。
- `providers/storage.ts`：产品 Provider，依赖选定的 `storageBackend` KV facet。
- `providers/memory.ts`：仅供 standalone 和聚焦测试使用的易失 Provider。

Domain ID 为 `permissions/approval-rules`，schema version 为 1。`run` 不落盘；`session` 和
`workspace` 使用 KV CAS 原子更新。损坏状态、Storage 错误和规则提交失败都 fail closed；
成功写入规则发生在 Core 最终 snapshot 检查之后、一次性 Grant 签发之前。
Storage Provider 为自己的完整 Cordis generation 持有 Backend lease，关闭 Store 后才释放；
因此 Backend 退休不会在规则读取或 durable commit 所属的依赖图尚未退出时提前 close。

## 配置与管理

产品图默认使用 backend `file`。可通过 `WISH_APPROVAL_RULE_MAX_RULES` 设置持久规则上限；
达到上限时拒绝新增，不静默删除长期授权。WebUI 提供：

```text
GET    /api/approval-rules
DELETE /api/approval-rules/:id
```

## 验证

```bash
npm run typecheck
npm run test:sandbox
npm run test:permissions
npm run test:apps-webui
npm test
```
