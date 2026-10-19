# Shell

`src/shell/` 是 `process.exec` 与真实子进程之间的强制执行 seam。它采用三种角色：

```text
Shell Service Definition
  <- Linux Native / Host Provider
  <- Bash Consumer
```

Bash 只声明命令所需的 capability，由 Shell Provider 执行进程调用。审批前，Shell
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
模型使用 `tmux_start`。后续调用通过 `tmux_list`、`tmux_capture`、`tmux_send` 和
`tmux_stop` 重新发现并控制真实 tmux 会话，用户也可使用返回的命令 attach 到同一会话。

`tmux_start` 不是绕过 Shell 的 Host spawn。Shell 先消费同一个一次性 Grant，并把命令物化为
不可变的沙箱 launcher argv；Tmux 只持有该 launcher。Linux Native 的 Landlock、seccomp、
clean environment、资源上限及调用级网络权限因此继续适用于长期进程。返回值公开真实 tmux
地址以便用户 attach，但 workspace-write pane 无权访问控制 socket，也不能借它创建未沙箱化窗口。

Linux Native Provider 为托管终端保留独立的私有 HOME/TMPDIR，直到终端被显式删除；Tmux
Provider 把该目录地址写入 tmux 元数据，因此 Provider reload 后仍能在删除终端时完成清理。
直接通过 Bash 创建 raw tmux 仍是运维逃生口，但不会自动获得 Wish 发现元数据，也不是模型的
标准长期执行路径。

Landlock 是 allow-list。为了在开放上层目录时仍保护 `.git`、`.wish` 和 `.env*`，native
launcher 会拆分普通子树；如果一个目录含有受保护的直属项，它不会获得“创建任意新直属
项”的宽授权。需要新建文件时应授权一个已存在的干净子目录。这是明确的 fail-closed
限制，不是隐藏的命令失败。

## Permission profile 对应关系

- `read-only`：只自动放行只读 Tool；只读 scope 的进程命令进入审批，修改和网络是硬边界。
- `workspace-write`：只有 path-scoped Linux Native Provider 能启用；除
  `enter_plan_mode` 和 `exit_plan_mode` 外，Tool 调用不因能力种类进入审批；
  路径、网络与进程执行仍须通过能力上限、SandboxPolicy 和 Native Provider 检查。
- `approval-required`：只读自动放行，其他调用进入审批；进程执行必须使用 Native Provider。
- `full-access`：显式退出 Landlock/seccomp 和审批，继承宿主环境，允许访问工作区外文件及
  网络。默认 Native Provider 只为这一 profile 走无隔离分支；其他 profile 不受影响。

整张图固定使用 Host Shell 仍需要双重显式配置：

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
