# Filesystem

`src/filesystem/` 是 Tool Capability 与本地文件 IO 之间的强制执行 seam。Tool 只声明
`filesystem.read` / `filesystem.write`，Core 完成授权并签发一次性 Grant，Filesystem
Provider 在真正打开文件前再次绑定 Grant、Permission Snapshot 和 Workspace Snapshot。

```text
Tool capability request
  → Filesystem.preflight / SandboxPolicy
  → Permissions authorize/revalidate
  → Core one-shot Grant
  → Filesystem Service
  → Local Filesystem Provider
  → operating-system file handle
```

## 文件职责

- `types.ts`：Provider-neutral policy、操作请求和返回类型。
- `errors.ts`：路径、边界、保护名称、符号链接、大小和 authority 错误。
- `service.ts`：Cordis `filesystem` Service Definition。
- `unavailable.ts`：standalone 组合缺少 Provider 时的 fail-closed 实现。
- `providers/local.ts`：本地 Provider 与可独立测试的 Backend。
- `consumers/model-tools/`：Read、Write、Edit 模型 Consumer，以及它们共享的路径解析和
  同路径 mutation queue；这些 Consumer 依赖 Filesystem Definition，不依赖 Local Provider。
- `search/types.ts` / `search/service.ts`：可替换的工作区文本搜索契约。
- `search/providers/local.ts`：不启动外部进程的 Local Search Provider。
- `search/consumers/`：Grep 模型 Consumer；它只依赖 Filesystem Search Definition。

## Local Provider 固定语义

- 相对路径基于 `WorkspaceSnapshot.root` 解析。普通文件可按明确路径跨工作区读取；
  写入在非 `full-access` 档位下仍限于该 root，`read-only` 禁止写入。
- 每次操作校验 Permission 的 workspace fingerprint/revision、Filesystem policy version、
  capability ceiling，以及 Core 签发且当前有效的同一 Grant。
- `preflight()` 复用相同路径解析与保护规则，但不要求尚未签发的 Grant；它只供
  SandboxPolicy 在审批前检查当前 Provider 是否能执行声明范围。
- 文件 Grant 默认是精确路径；目录 Grant覆盖其后代，供 Grep 这类目录读取使用。
- 读取与写入都拒绝路径组件中的符号链接、特殊文件和受保护路径；扩大可读范围不会扩大
  单次 Grant。目录 Grant 只能覆盖该目录后代，跨工作区写入也必须在 Grant 中明确声明。
- 默认保护 `.git`、`.wish`、`.ssh`、`.aws`、`.gnupg`、`.azure`、`.kube`、`.docker`、`.codex`，
  以及 `.env`、`.gitconfig`、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials` 和 `.env.*`。
  `.env.example` 是名称例外；绝对路径锁仍优先生效。
- `protectedPaths` 对指定绝对路径及其后代同时禁读、禁写，支持尚不存在的路径，并锁定已有
  符号链接父目录的规范路径。默认包含 `/proc`、`/sys`、`/etc/shadow`、`/etc/gshadow`。
  部署可通过 `WISH_FILESYSTEM_PROTECTED_PATHS` 配置逗号分隔的绝对路径；该值替换默认列表。
  名称、前缀、例外仍由 `WISH_FILESYSTEM_PROTECTED_*` 配置。保护规则在全部四个档位生效，
  不由审批或 `full-access` 自动解除。
- Read/Write 有统一的 64,000,000 字节上限；Write 可逐级创建普通父目录，写入成功前
  对文件句柄执行 `fsync`。
- 支持 `AbortSignal`，但写入进入 truncate/write 后的中断仍属于
  `needs-reconciliation`，不会被声明为安全重试。

策略数组和大小上限由 Loader 配置拥有。策略内容生成稳定 version，并进入每个 Step 的
`PermissionSnapshot.authorityVersion`；Provider generation 更新只作用于新的 Application/
Step generation。

## 当前边界

Local Provider 对普通进程内文件工具提供强制边界，但 Node 路径检查无法抵御另一个恶意
本地进程在检查和打开之间并发替换父目录，不提供 hostile-host TOCTOU 文件句柄遍历保证。
Bash 使用 Linux Native Shell，把同一组敏感规则与声明的读写路径落实到 Landlock。
保护基于路径与名称规则，不识别任意文件正文中的秘密；不提供恶意 Host 并发改名或已有硬链接别名的完整防护。

Grep 是 Filesystem Search 的 Tool Consumer。Local Search 通过 Node 目录遍历实现，不启动
`rg` 或其他子进程；搜索根和每次文件读取都绑定同一 Filesystem generation、Step context
和一次性 Grant。它确定性排序目录项，跳过符号链接、受保护名称、二进制和无效 UTF-8
文件；权限、authority 或 Provider 故障不会作为“无匹配”静默吞掉。默认最多遍历 50,000
个文件和 10,000 个目录，分别可由 `WISH_FILESYSTEM_SEARCH_MAX_FILES` 与
`WISH_FILESYSTEM_SEARCH_MAX_DIRECTORIES` 收紧。Local Search 只支持 `*`、`**` 和 `?` glob，
不解析 `.gitignore`。

## 验证

```bash
npm run typecheck
npm run test:filesystem
npm run test:permissions
npm run test:cordis-agent-loop
npm test
```
