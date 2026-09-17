# Skills

Skills 管理可复用的操作说明和包内资源。它不执行脚本、不授予权限、不拥有
AgentLoop、Session、Plan 或任务调度状态。Tool 只是可选 Consumer。

## 来源与包格式

`LocalSkills` 接受 Host 提供的绝对 `userRoot` 和 Workspace 规范化 `cwd`。
Cordis Local Provider 依赖 launch，默认用户目录为 Host homeDirectory 下的
`~/.wish/skills`；纯核心没有隐式用户目录。
项目唯一来源是 `<cwd>/.agents/skills`，不搜索祖先目录或 `.wish/skills`。
先枚举用户源，再枚举项目源；每个源按目录名排序。同名时先成功加载的包胜出，
其余记录在 `catalog.issues`。无效包不会静默覆盖有效包。

每个一级包目录必须包含 `SKILL.md`，YAML frontmatter 要求：

```yaml
---
name: inspect-code
description: Inspect code before editing and run focused verification.
disable-model-invocation: false
---
Complete instructions follow here.
```

名称必须匹配目录名，使用 1–64 个小写字母、数字和单连字符；description 为
1–1024 字符。YAML 仅用数据 schema，重复键、非法类型、空正文会被拒绝。
`disable-model-invocation: true` 的包仍能由 Host 读取，但不进入模型目录，
模型读取入口也不能通过更换参数加载它。

默认最多 100 个有效包，每个源最多 1000 个目录项，每个文件最多 64000 字节；
配置上限分别为 1000 个包、1000000 字节。超过限制返回诊断或明确失败。

## 读取、一致性与安全

Host 通过 `list({ cwd })` 查询，通过 `read({ cwd, name, expectedDigest })`
读取完整有界正文。模型不能指定 cwd、用户目录或 invocation 类型。
资源仅允许 `SKILL.md`、`references/**`、`scripts/**`、`assets/**` 内的 UTF-8
文本；绝对路径、空段、`.`、`..`、反斜杠、NUL、符号链接和硬链接文件均被拒绝。
加载脚本文件只返回文本。执行仍须现有 Shell／Sandbox 授权，长任务仍由 tmux 承载。

本地 Provider 当前要求 Linux `/proc` 和逐级目录 fd／`O_NOFOLLOW` 读取，
拒绝通过父目录链接替换逃逸；其他平台无不安全回退。读取前后还校验文件身份、
大小和修改时间。此约束不防御拥有宿主权限的进程修改进程自身或内核。

`expectedPackageId` 固定来源和包位置，模型入口必须提供它；相同 manifest 内容
也不能掩盖用户／项目来源切换。Host 可选择携带它来拒绝来源变化。
`expectedDigest` 固定 SKILL.md 版本，不声称固定整棵资源树。资源独立返回
`digest`。分页使用 Unicode code-point offset；后续页必须携带该资源的
`expectedResourceDigest`，更改即失败。`nextOffset` 表示仍有后续内容；
`complete: true` 仅表示本次返回了完整文件。Host 不提供 limit 时返回全文；
模型默认每页 3000 字符，上限 4000，必须读完 SKILL.md 全部页再使用。
模型入口还限制编码后的完整响应为 7000 字符，JSON 转义膨胀时自动缩短当前页，
并返回准确 nextOffset；默认 Context 长结果裁剪不会把这一页再次截断。若 Host
配置更低的裁剪阈值，仍须相应调整该入口或通过归档读取，不应假设内容完整。
删除、禁用和 manifest 变化会在每次读取重新检查，不从旧缓存恢复已撤销包。

## 可选装配

- `providers/local.ts`：`skills` Service。配置 `userRoot`、`maxSkills`、`maxFileBytes`。
- `consumers/context.ts`：依赖 skills/contextEngine，不依赖 Tools Service。
  根据本 Step `request.availableTools` 判断 read_skill 是否可用；不可用或缺少
  请求视图时不注入目录。默认最多 20 条／8000 字符目录，配置
  `maxEntries`、`maxCharacters`；固定指导与不可信目录分开，正文不自动注入。
- `consumers/model-tools.ts`：依赖 skills/tools，注册 list_skills、read_skill。
  list_skills 默认每页 5 条，上限 20；后续页要求 expectedCatalogDigest。
  只使用 runtime.read，授权绑定工具名、策略／权限版本、Workspace、完整 Step
  身份和精确请求参数；异步读完再次检查活动授权，拒绝失效、重放或跨 Step 使用。
- `consumers/mode-controls.ts`：SkillsPlanControls 和 SkillsCoordinatorControls
  分别依赖自己的模式，只注册两个读入口，不自动开放脚本执行或写操作。
- `consumers/session-feature.ts`：Host 人类只读目录／正文面板，包含 manual-only
  包；使用 Session 所属 Workspace，固定目录／Session token，用户填写准确名称
  后完整读取正文。仅保存最多 100 个 Session 的临时查看位置，每次展示重新校验，
  不是模型激活表。默认插件使用 Sessions Service 的默认 manager；独立 Application
  使用其他 dataDirectory 时应通过工厂传入对应 Session graph 的 Workspace Port。
- `presentation.ts` 与 `consumers/webui/`：SessionFeature 额外提供模块自有的结构化目录投影；
  Browser 的 React-free Client Model 校验后，把当前 Workspace 的 Skill 分组放入专属侧栏。
  点击条目通过已有 Host 版本 token 读取正文，不经过会话侧栏，不显示手动刷新，也不会激活
  Skill。停用 Skills UI Consumer 会一并撤销全局入口、目录侧栏和正文视图。

Tools、Context、模式适配器均由各自 Fiber 维护注册生命周期。卸载 Consumer
不销毁独立能力。Context 在每个新 Step 从当前注册表捕获 Provider 集合，同一
Step 的重投影固定集合；卸载会取消并排空进行中的读取，不让旧 Provider 继续泄露内容。

## 当前边界

Host 可显式读取 manual-only 包；人类面板提供“查看”，但尚无持久 Session 激活表，
查看正文不会将该包变成模型可调用。用户消息、steering 或 follow_up 的文本不会伪造显式选择。
普通模型可按目录自主调用允许的包。没有自动执行、Skill 编辑工具、文件监听、
远程包安装、语义推荐、子 Agent 包复制或整包快照。Compaction 后可重新查询目录，
按仍有效的 digest 重读；这不是持久化“已激活 Skill”的承诺。

## 验证

构建后执行 `node scripts/accept-skills.mjs` 和
`node scripts/accept-skills-consumers.mjs`；类型契约见 `type-tests/skills.ts`。
测试覆盖解析、来源冲突、路径／链接边界、分页一致性、取消、权限、模式控制、
上下文不可信边界和 Tool Consumer 的卸载；不代表真实 Provider 或浏览器验收。
