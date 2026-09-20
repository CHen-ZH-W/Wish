# Workspace

Workspace 是一次执行所依赖的工作区事实能力。它把调用方选择的目录解析为不可变的
`WorkspaceSnapshot`，供同一个 Runtime Step 内的 Context、Tools、Policy、Shell、
FileSystem、Git、LSP、Memory 和 Skills 共享。

## 契约

- `ResolveWorkspaceRequest.root` 是调用方选择的目录写法。
- `WorkspaceSnapshot.requestedRoot` 保留规范化但尚未解析符号链接的输入，仅用于诊断。
- `WorkspaceSnapshot.root` 是 Provider 解析出的 canonical execution root。
- `fingerprint` 表达工作区身份，不应随 Git HEAD 或普通文件内容改变。
- `revision` 表达本次捕获的工作区事实版本，可以随 instructions、repository facts 或
  其他已声明事实改变。
- `instructions` 是经过读取、验证、排序并取得快照的事实；Context 不扫描它们的来源。
- Snapshot 及其嵌套值必须由 Provider 冻结。AgentLoop 在一个 Step 只解析一次；Tools
  获得完整 Snapshot，Context 从该 Snapshot 投影同一 fingerprint、revision、repository
  与 instructions，不允许各自重新扫描。

## 边界

Workspace Service Definition 不依赖 Session、Context 或具体工具。Consumer 从
`Session.scope` 等业务对象提取根目录后再调用 `resolve()`。

Workspace 不承担以下职责：

- 持久化用户登记的项目列表；项目登记属于独立 Registry 能力。
- 读写任意工作区文件；这是 FileSystem 能力的职责。
- 决定某次操作是否允许；这是 Policy 的职责。
- 执行 Shell 或 Git 命令。
- 保存 Session、Tool Result、Trace 或其他 Wish 内部状态。

Provider 必须把路径输入错误映射为稳定的 `WorkspaceErrorCode`。取消继续使用平台原生
`AbortError`，不伪装成 Workspace 故障。

## Local Provider

`LocalWorkspace` 以 `launch.cwd` 为相对路径基准，拒绝空白、首尾空格和 null byte，
然后依次执行 `realpath`、目录类型检查及读/进入权限检查。canonical root 决定
`fingerprint`，所以同一目录的不同符号链接写法共享身份；`requestedRoot` 只用于诊断。

Provider 从 execution root 向上寻找第一个 repository marker，默认是 `.git`，不执行
Git 命令。找到 repository 后，以 repository root 为 instruction root；否则只读取
execution root。指令目录按 instruction root 到 execution root 排序，每层再按
`AGENTS.md`、`AGENTS.local.md` 的配置顺序读取，因此更靠近当前目录的事实排在后面。

每个 instruction 都携带稳定 ID、来源路径、内容 digest 和明确的 `developer`
authority。符号链接目标逃出 instruction root、读取失败、非法 UTF-8 或超过限制都会
fail closed；空文件被忽略。默认单文件上限是 64 KiB，一次 Snapshot 的指令总量上限是
128 KiB。

Local Provider 的 Loader Config 为：

- `instructionFiles`：目录内候选文件名，必须是无路径分隔符的 leaf name；
- `repositoryMarkers`：向上识别 repository 的 marker leaf name；
- `maxInstructionFileBytes`：单文件字节上限；
- `maxInstructionBytes`：一次解析的总字节上限。

默认 `cordis.yml` 对应支持
`WISH_WORKSPACE_INSTRUCTION_FILES`、`WISH_WORKSPACE_REPOSITORY_MARKERS`、
`WISH_WORKSPACE_MAX_INSTRUCTION_FILE_BYTES` 和
`WISH_WORKSPACE_MAX_INSTRUCTION_BYTES`。前两项是逗号分隔列表。

## 生产接线

`workspace-local` 是 `workspace` Service 的默认 Provider。`agentLoop` 显式注入该
Service，并在每个 Step 用 `Session.scope` 作为 `ResolveWorkspaceRequest.root`。Provider
缺失或被 Loader 禁用时，`agentLoop → runtime → agents → application → surface` 保持
PENDING；Provider 恢复后由 Cordis 重新激活。

Workspace 不提供 Registry、受保护路径、访问授权或 sandbox。Registry、Policy、
FileSystem 与 Shell 是独立 seam，按各自契约消费 Workspace Snapshot；Local Provider
不承载这些职责。

## WebUI 目录选择

`directory-picker/types.ts` 声明独立接口；`local.ts` 是与 Step Snapshot 解析分离的只读
Host 目录浏览实现，由 WebUI 装配层注入，业务 HTTP 路由不直接依赖本地文件系统实现。
它只返回规范路径、面包屑和可进入的子目录（包括指向目录的符号链接），不读取文件正文；
每层最多返回 500 项并标明截断。WebUI 通过受管理令牌保护的 POST API 调用，浏览器侧
`consumers/webui` 只保存临时选择和导航状态，不登记 Workspace，也不创建 Session。
选定的路径仍须经过会话创建接口的 Host 目录校验。

## 验证

```bash
npm run typecheck
npm run test:workspace
npm run test:cordis-agent-loop
npm run test:cordis-isolation
```
