# Tools

`src/tools/` 提供 Wish 的具体基础 Tool，以及供 App 组合的交互授权适配。它实现文件
和进程操作，但不接管 Core 已经拥有的 Registry、输入调用解析顺序、Grant、Executor、
Scheduler 或 AgentLoop。

```text
basic/*.ts
  → ToolDefinition
  → Core ToolRegistry
  → Core ToolExecutor
  → Core BoundedToolScheduler
  → AgentLoop

CLI / WebUI approval
  → ToolApprovalPort
  → InteractiveToolAuthorizationService
  → Core ToolExecutor
```

每个 Tool 直接实现
`ToolDefinition<Name, Input, Output, BasicToolContext>`。Core 在调用 `execute` 前完成
参数解析、能力申请、授权复核和一次性 Grant 签发；具体 Tool 在访问资源前再次检查
Grant 是否仍处于本次调用的有效范围。

## 当前状态

| Tool | 状态 | executionMode | recoveryPolicy | capability |
| --- | --- | --- | --- | --- |
| `read` | 已实现 | `parallel` | `retry-safe` | `filesystem.read` |
| `write` | 已实现 | `sequential` | `needs-reconciliation` | `filesystem.write` |
| `edit` | 已实现 | `sequential` | `needs-reconciliation` | `filesystem.read`, `filesystem.write` |
| `grep` | 已实现 | `parallel` | `retry-safe` | `filesystem.read` |
| `bash` | 已实现 | `sequential` | `needs-reconciliation` | `process.exec` |

五个 Tool 均已实现并完成各自定向验收，通过 `registerBasicTools` 才会进入宿主提供的
Registry。

## 目录职责

```text
src/tools/
├── README.md
├── index.ts                 # 注册和公共组合入口
├── authorization.ts         # App-neutral approval 到 Core authorization 的适配
├── basic/
│   ├── read.ts
│   ├── write.ts
│   ├── edit.ts
│   ├── grep.ts
│   └── bash.ts
└── support/
    ├── context.ts
    ├── path.ts
    ├── truncate.ts
    ├── mutation-queue.ts
    └── result-renderer.ts
```

- `basic/`：Tool schema、typed parser、能力解析、执行逻辑、稳定输出和
  `*Operations` 注入接口。
- `support/context.ts`：一次执行所需的 `cwd` 和模型图片能力。
- `support/path.ts`：`~`、绝对路径、相对 `cwd` 路径、常见 Unicode 空格及文件名
  normalization。这里不实现 workspace 访问策略。
- `support/truncate.ts`：共享的 2000 行、50KB 和 Grep 单行 500 字符限制，并保证
  UTF-8 截断不产生破损字符。
- `support/mutation-queue.ts`：Write 与 Edit 共用的进程级同路径串行队列；不同路径
  仍可并行。
- `support/result-renderer.ts`：把 Core `ToolResult` 转为模型可见的中立 Tool
  Message。Read/Grep/Bash 提取文本 content；Write/Edit 生成稳定成功说明；失败结果
  保留错误码和消息。Read 图片以 `data:` URL 写入 `contentParts.image_url`，不会把
  base64 混入普通文本。未知输出结构使用紧凑 JSON 兜底。渲染结果固定保留
  `role=tool` 和原 `toolCallId`。
- `index.ts`：把五个 Tool 按 `read → write → edit → grep → bash` 的固定顺序注册到
  外部提供的 `ToolRegistry<BasicToolContext>`，并返回 Registry 自己的注销句柄。
  `BasicToolsOptions` 可以分别注入各 Tool 的 Operations。注册前如果存在同名 Tool，
  Registry 保持原状；意外的中途注册失败也会回滚本次已经加入的 definition。
  该入口同时公开结果渲染器和授权适配，但不创建 Registry、Executor 或 Scheduler。
- `authorization.ts`：`ToolApprovalPort` 只描述一次 CLI/WebUI 审批交互；
  `InteractiveToolAuthorizationService` 把批准转换为 Core 的 `authorize → revalidate`
  协议。批准绑定同一份 call、capabilities、scope 和 Step snapshot，只能复核一次；
  等待期间 policy version 改变会在 dispatch 前拒绝。`createDenyAllToolAuthorizationService`
  是尚未接入审批 App 时的显式 fail-closed 默认值。

包级组合入口是 `wish/tools`：

```ts
import { ToolRegistry } from "wish/core/tools";
import {
  InteractiveToolAuthorizationService,
  createBasicToolResultRenderer,
  registerBasicTools,
  type BasicToolContext,
} from "wish/tools";

const registry = new ToolRegistry<BasicToolContext>();
const registrations = registerBasicTools(registry);
const toolResults = createBasicToolResultRenderer();

const authorization = new InteractiveToolAuthorizationService({
  policyVersion: () => currentPolicyVersion,
  approval: cliOrWebApprovalPort,
});
```

## 集成边界

完整集成验收使用真实的 Registry、Executor、Bounded Scheduler、ContextProjector、
AgentLoop 和 Runtime。首个 Step 向 Model 暴露五个 schema，并执行五个经过独立能力
授权的 Tool Call；下一 Step 按原调用顺序收到五条配对的 Tool Message，包括 Read
图片的 `contentParts.image_url`。文件与进程 Operations 使用确定性注入，因此该验收
证明 Core 到基础 Tool 的组合合同，不声称真实 Sandbox 或远端 Provider 已完成验证。

Operations 接口保留在各自 Tool 文件中，不集中为一个跨 Tool 大接口。宿主可用它们
接入远端文件系统、图像处理器或进程后端；默认实现只负责本地能力。

## Read

输入：

```json
{
  "path": "src/file.ts",
  "offset": 1,
  "limit": 200
}
```

- `offset` 和 `limit` 可省略；存在时必须是正整数。
- `offset` 使用 1-based 行号。超过文件末尾会返回 `invalid_input`。
- 不设置默认 `limit`。未指定时仍受 2000 行和 50KB 的共享 head 限制。
- 内容被 `limit` 或共享限制截断且仍可按行续读时，文本提示和结构化输出都会给出
  `nextOffset`。
- 文本按 UTF-8 读取。单行自身超过 50KB 时返回明确说明，不返回破损的部分字符。
- 通过文件签名识别 JPEG、PNG、GIF 和 WebP，不依据扩展名猜测。
- 图片输出使用中立的 `text`/`image` content；图片数据为 base64。宿主可以注入
  `ReadImageProcessor` 进行缩放或重新编码。
- `modelSupportsImages` 明确为 `false` 时，只返回图片已省略的文本说明。
- `ReadOperations` 可替换 access、读取和图片类型识别；AbortSignal 会传给可注入
  操作。
- 不计算内容 hash，也不提供 hash 前置条件。

## Write

输入：

```json
{
  "path": "src/file.ts",
  "content": "complete file content"
}
```

- 文件不存在时创建，父目录不存在时递归创建。
- 文件存在时完整覆盖，包括用空字符串清空文件。
- `WriteOperations` 可替换目录创建和文件写入。
- 与 Edit 共用 mutation queue，同一规范化路径严格串行。
- 不提供 `overwrite`、`expectedSha256` 或增量追加参数。
- 返回原始输入路径和实际写入的 UTF-8 字节数。

Write 是可能已经产生副作用的调用。dispatch 后发生进程中断时，不能根据缺少结果
推断写入是否发生，也不能由 Core 自动重放。

## Edit

输入：

```json
{
  "path": "src/file.ts",
  "edits": [
    {
      "oldText": "before",
      "newText": "after"
    }
  ]
}
```

- 一次调用可以提交多个 replacement；所有 `oldText` 都针对调用开始时的同一份原始
  内容匹配。
- 每个 `oldText` 必须恰好出现一次，replacement 之间不得重叠或嵌套。
- 校验全部通过后按位置从后向前应用，避免前面的修改改变后续位置。
- 精确匹配失败后会统一 NFKC、行尾空白、Unicode 空格、智能引号和 Unicode dash。
- 保留 UTF-8 BOM，并按原文件的 CRLF 或 LF 写回。
- 无实际变化、找不到文本、文本不唯一或 replacement 冲突时返回 `conflict`，且不写
  文件。
- 返回应用数量、带行号 diff 和首个修改行。
- `EditOperations` 可替换 access、读取和写入；与 Write 共用 mutation queue。
- 不提供 occurrence、`expectedSha256` 或其他并发覆盖开关。

Edit 与 Write 一样采用 `needs-reconciliation`：未知的已 dispatch 操作必须先核对
外部状态，不能直接作为一个新调用重放。

## Grep

输入：

```json
{
  "pattern": "ToolDefinition",
  "path": "src",
  "glob": "**/*.ts",
  "ignoreCase": false,
  "literal": false,
  "context": 1,
  "limit": 100
}
```

- `path` 默认是 `BasicToolContext.cwd`，也可以指向单个文件。
- 默认按正则且区分大小写；`literal=true` 使用固定字符串匹配。
- `glob` 直接作为一个 `rg --glob` 过滤条件；搜索启用 hidden 文件，但仍遵守
  `.gitignore`。
- `context` 默认是 0，存在时必须是非负整数。上下文从匹配文件读取，并使用
  `path-line- text` 区分非匹配行。
- `limit` 默认是 100，存在时必须是正整数。达到 limit 后立即终止当前 `rg` 子进程，
  并在结果中给出缩小搜索或提高 limit 的提示。
- 每条源文件内容最多保留 500 个 Unicode 字符；总模型可见文本（包括截断提示）最多
  50KB，不会切断 UTF-8 字符。
- 没有匹配时稳定返回 `No matches found`。路径不存在、`rg` 缺失和 `rg` 执行失败使用
  可区分的 Tool 错误。
- `RipgrepResolver` 只负责定位可执行文件。默认 resolver 搜索 `PATH`，不会下载或安装
  二进制；宿主可以注入自己的定位或安装流程。
- `GrepOperations` 可替换路径检查、上下文文件读取和子进程启动，AbortSignal 会传给
  文件操作。
- 收到 abort 时会终止活动 `rg` 子进程，不返回部分结果作为成功。

## Bash

输入：

```json
{
  "command": "npm run typecheck",
  "timeout": 120
}
```

- 只接受 `command` 和可选 `timeout`，不接受调用级 `cwd`、环境变量或 permissions。
- `command` 可以是空字符串；`timeout` 存在时必须是大于 0 的有限秒数，可以包含小数。
- 不提供默认 timeout。命令固定在 `BasicToolContext.cwd` 中执行。
- capability 是 `process.exec`。Grant 仍由 Core 绑定到本次 Bash Tool Call，不能被
  其他调用复用。
- 默认本地后端在 Unix 上优先使用 `/bin/bash`，否则使用环境 shell 或 `sh`；Windows
  使用 `bash.exe`。也可以通过 `createLocalBashOperations` 显式指定 shell 和环境。
- stdout 与 stderr 按到达顺序进入同一个输出流。`BashOperations` 可以替换完整执行
  后端，并接收 cwd、AbortSignal、秒级 timeout 和合并输出回调。
- 最终模型可见内容只保留最后 2000 行或 50KB，并保证 UTF-8 尾部完整；空输出稳定
  显示为 `(no output)`。
- 输出超过限制时，完整原始字节流写入权限为 `0600` 的临时文件，并在成功输出或错误
  details 中返回 `kind=file` artifact。模型可见文本连同截断和终态提示仍不超过 50KB。
- 非零退出码返回 `execution_failed`，错误正文和 details 都保留可见输出尾部及退出码。
- timeout 返回 `timeout`；外部 abort 返回 `aborted`。默认本地后端会终止 shell 的
  整个进程树，而不是只终止直接子进程。
- `exitCode=null` 且没有 timeout/abort 标记时作为正常终态保留。
- 当前 Core Tool 接口没有 progress 回调，因此这里只返回最终结果，不自行发布实时
  输出事件。

Bash 是可能已经产生外部副作用的调用。dispatch 后没有终态记录时必须先核对外部
状态，不能自动重放为一个新调用。

## 固定边界

交互授权服务不决定 UI 长什么样，也不持久化“以后都允许”规则。CLI 与 WebUI 各自实现
同一个 `ToolApprovalPort`，因此不会把终端输入、HTTP/WebSocket 或前端状态带进 Tools。

本模块仍不实现：

- 审批 UI、持久 allow/deny 规则；
- AgentMode 权限和 workspace 路径限制；
- Linux、容器或远端 Sandbox；
- 网络访问策略；
- TUI、WebUI 或 Provider 专用结果格式；
- Tool lifecycle 持久化与未知副作用自动恢复。

路径解析不是授权。宿主仍需通过 Core 授权服务和实际 Sandbox 后端执行资源限制。

## 维护与验证

Tool 的输入、输出、能力、调度、恢复语义或可见错误发生变化时，必须在同一次修改中
更新本 README 和对应定向验收。

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:basic-tools-path
npm run test:basic-tools-truncate
npm run test:basic-tools-mutation-queue
npm run test:basic-tool-read
npm run test:basic-tool-write
npm run test:basic-tool-edit
npm run test:basic-tool-grep
npm run test:basic-tool-bash
npm run test:basic-tools-result-renderer
npm run test:basic-tools-index
npm run test:basic-tools-integration
npm run test:tool-authorization
npm test
```
