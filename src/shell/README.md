# Shell

`src/shell/` 是 `process.exec` 与真实子进程之间的强制执行 seam。它采用三种角色：

```text
Shell Service Definition
  <- Linux Native / Host Provider
  <- Bash Consumer
```

Bash 只声明命令所需的 capability，不再默认调用 `child_process.spawn()`。审批前，Shell
Provider 通过 `preflight(request)` 固定并验证命令、cwd、timeout、文件路径 scope、网络
开关和 policy generation；Core 签发一次性 Grant 后，`resolve(request)` 再绑定 authority，
最后由 `run(spec)` 启动进程。Spec 只能由创建它的 Provider 消费一次。

## 文件职责

- `types.ts`：Provider-neutral policy、preflight/resolve/spec/run 请求和结果。
- `errors.ts`：输入、权限、策略代际、不可用和执行错误。
- `service.ts`：Cordis `shell` Service Definition。
- `unavailable.ts`：standalone 图缺少 Provider 时的 fail-closed 实现。
- `providers/linux-native.ts`：Landlock/seccomp Provider 及 Grant/Step 绑定。
- `providers/host.ts`：显式启用的开发逃生口，不提供进程隔离。
- `providers/process.ts`：共享的 timeout、abort 和进程组回收机制。
- `consumers/model-tool.ts`：同步 Bash 模型 Consumer；它只依赖 Shell Definition，
  不依赖 Linux Native 或 Host Provider。
- `native/wish-linux-sandbox.c`：在 exec 前安装 OS 级限制的 launcher。

## Linux Native Provider

默认产品图使用 `shell-linux-native`。它要求 Linux Landlock ABI 3 或更高，并支持 x86_64
和 aarch64。构建时 `npm run build:native` 使用 `CC`（默认 `cc`）生成 launcher。

每次执行都会：

- 重新绑定 active Core Grant、Permission Snapshot、Workspace Snapshot、Filesystem 与
  Shell policy version；`process.exec` 必须精确包含当前命令。
- 用同一个 Filesystem Provider 校验最多 128 个 workspace-relative read/write scope，
  拒绝 Workspace 外路径、符号链接、缺失 scope 和受保护名称。
- 用 Landlock 只开放声明的文件树、只读系统运行时目录和本次私有临时目录。
- 默认仅允许 Unix-domain local IPC，并拒绝创建其他 socket；只有
  `network.connect hosts=["*"]` Grant 才为本次调用开放互联网 socket。当前网络粒度明确为
  all-or-none，不伪装成 hostname 级隔离。Unix socket 仍受 Landlock 路径 scope 限制。
- 固定清空继承环境，只恢复 PATH、私有 HOME/TMPDIR/npm cache 和 locale，避免 Provider
  API key 泄漏给命令。
- 设置 core dump、CPU、文件大小、打开文件、地址空间和进程数限制，并拦截 30 类以上的
  mount/namespace、ptrace、BPF、内核模块、keyring、reboot、设备节点、ownership/xattr、
  clock 等高风险 syscall。
- timeout 或 AbortSignal 先终止整个进程组，宽限期后强制 SIGKILL。

## No background Bash 与 tmux

Bash 没有 `run_in_background`、job id、后台输出缓冲或跨调用 stdin handle。Tool 调用同步等待
当前 shell 命令；需要持续存在、可查询和可交互的 dev server、watcher、调试器或 REPL 时，
使用 tmux。`tmux new-session -d` 的客户端同步退出，后续调用通过稳定 socket 执行
`list-sessions`、`capture-pane`、`send-keys` 和 `kill-session`，用户也可 attach 到同一会话。

Linux Native Provider 每次调用的 HOME/TMPDIR 都是临时目录，因此透明会话必须显式使用
Workspace 内已授权的持久目录与 socket，例如先创建普通目录，再使用
`tmux -S "$PWD/runtime/tmux.sock"`。创建 tmux server 时的 Sandbox 权限会被长生命周期进程
继承；不同权限 ceiling 不得共享同一个 server。

Landlock 是 allow-list。为了在开放上层目录时仍保护 `.git`、`.wish` 和 `.env*`，native
launcher 会拆分普通子树；如果一个目录含有受保护的直属项，它不会获得“创建任意新直属
项”的宽授权。需要新建文件时应授权一个已存在的干净子目录。这是明确的 fail-closed
限制，不是隐藏的命令失败。

## Permission profile 对应关系

- `read-only`：只自动放行只读 Tool；只读 scope 的进程命令进入审批，修改和网络是硬边界。
- `workspace-write`：只有 path-scoped Linux Native Provider 能启用；工作区读写与无开放
  世界效应的命令自动放行，高风险 capability 仍进入审批。
- `approval-required`：只读自动放行，其他调用进入审批；进程执行必须使用 Native Provider。
- `full-access`：只有 `shell-host` 且 `enabled=true` 时可用。它继承宿主环境，且不能强制
  文件/网络 scope，因此默认配置不会启用。

选择 Host 需要双重显式配置：

```bash
WISH_SHELL_PROVIDER=host WISH_SHELL_HOST_ENABLED=1 WISH_PERMISSION_PROFILE=full-access
```

## 验证

```bash
npm run typecheck
npm run test:shell
npm run test:shell:tmux-real
npm run test:permissions
npm run test:cordis-agent-loop
npm test
```
