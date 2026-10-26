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

## 显式完整快照与附加来源

`LocalSkills.snapshot({ cwd, signal })` 是显式只读操作，返回 `SkillPackageSnapshot[]`。
每个包保存原来源和 packageId、SKILL.md 以及 `references/`、`scripts/`、`assets/`
下全部允许的 UTF-8 文本字节、逐资源大小／SHA-256 和整包 digest。它不会执行脚本或写入
用户目录。每包最多 256 个文件、1024 个目录项、4 MiB；一次完整快照最多 1000 个包、
16 MiB 内容，逐文件仍遵循 Provider 配置。根目录其他文件不属于允许资源，不会自动打包。
资源捕获两次并比较目录与内容，变化、诊断、链接、硬链接、无效 UTF-8 或越界会失败。
UTF-8 BOM 作为正文的一部分保留，摘要覆盖实际字节。完整快照不会被默认 Profile capture
或普通 Skill 读取隐式启用。

`createSkillPackageSnapshot(skill, files)` 校验显式包数据；`validateSkillPackageSnapshot`
复验摘要和元数据。`FrozenSkills(packages)` 提供只读 `list/read/snapshot`，仍检查
manual-only、来源、manifest/resource digest 与分页。它不会替换生产 Provider。

Host 可调用 `registerSource({ id, list, read, snapshot })` 附加 `SkillSource`，返回幂等撤销
函数。Local Provider 将注册绑定到调用 Fiber 的 effect；撤销会取消并拒绝进行中读取的
迟到结果。附加来源排在本地用户／Workspace 来源之后，同名时较早来源胜出。来源仍声明
`user` 或 `workspace`，不会因注册得到更高权限；packageId 额外绑定 source id，避免来源
更换复用旧授权。读取时继续检查调用身份、manual-only 与原始 manifest，不允许来源声称
模型可调用却提供 manual-only 内容。没有附加来源时沿用原来的枚举顺序与 packageId。
完整快照要求可见来源均支持全包捕获；它不会把无法捕获的资源静默当成空包。

`evolution/skill-proposals.ts` 基于完整包构造可评审的局部修改、同基准修改归并、多包合并、
拆分和淘汰 proposal。每份 proposal 保留完整原包与内容 digest；同一路径的竞争修改形成
显式冲突，解决后产生下一版本。合并记录逐资源去向，拆分缺少资源去向时保持 conflicted。
这些函数只构造数据，不写 Skills 目录、接受 Memory 或发布插件；持久化与发布由调用方负责。
验收见 `node scripts/accept-skill-change-proposals.mjs`。

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
  SessionFeature 投影仍供会话内的人工审阅使用；独立 WebUI 页面使用下述 library Control。
- `consumers/webui-control.ts`：依赖 skills/workspace/webUiControls，提供独立于 Session 的
  技能库。目录使用 WebUI 配置的启动工作区与用户源，正文读取固定 packageId/digest；
  不跟随选中会话，也不会创建会话。`GET /api/controls/skills/default` 返回目录及导入能力，
  `POST /api/queries/skills/default` 读取正文，`POST /api/controls/skills/default` 手动导入。
  POST 沿用 WebUI 的同源和管理令牌校验，客户端不能指定写入根目录。
- `consumers/webui/`：独立 React-free Client Model 通过 Connection 浏览技能库；页面与
  专属侧栏按用户／工作区分组，使用既有 Markdown 展示正文并保留可展开的原文。
  文件夹或单个 `SKILL.md` 导入成功后立即更新目录并打开正文；离线、Host 替换及卸载
  撤销旧操作，迟到结果不能覆盖新目录。切页保留当前标签页内的导入草稿。
  停用 Skills UI Consumer 会一并撤销全局入口、目录侧栏和正文视图。

## 手动导入

本地 Provider 可将一个 Skill 包导入已配置的用户根目录，默认是 `~/.wish/skills`。
支持单独的 `SKILL.md`，或包含该文件及 `references/`、`scripts/`、`assets/` 下 UTF-8
文本的文件夹；文件夹前缀会移除，包目录按清单中的 `name` 创建。每文件限制沿用
Provider `maxFileBytes`，每包最多 256 文件／512000 字节，HTTP 请求另受 1 MiB JSON 上限
约束。二进制、路径越界、重复路径、格式错误和不支持的资源都会明确拒绝。
`agents/openai.yaml` 当前不受支持，不能通过导入静默丢弃其中的调用策略。

导入默认拒绝同名项；人工勾选覆盖后，也只能替换当前用户根中的本地同名包，不能替换
工作区或插件来源。所有导入携带已展示目录的摘要，目录变化时先刷新再重试。
`LocalSkillImporter` 在写入前完整校验，在有界暂存目录内准备所有文件，提交前再次核对
目录与目标身份；同一 Provider 内串行导入。覆盖替换整个包，移除旧资源，不逐文件合并。
普通提交失败恢复旧包；若进程在目录重命名之间崩溃，保留的 `.wish-skill-backup-*` 是
人工恢复证据，不承诺跨进程崩溃事务或自动恢复。导入不执行资源脚本。
冻结的隔离 Provider 不开放导入，其他替代 Provider 可不实现该可选能力。

Tools、Context、模式适配器均由各自 Fiber 维护注册生命周期。卸载 Consumer
不销毁独立能力。Context 在每个新 Step 从当前注册表捕获 Provider 集合，同一
Step 的重投影固定集合；卸载会取消并排空进行中的读取，不让旧 Provider 继续泄露内容。

## 当前边界

Host 可显式读取 manual-only 包；人类面板提供“查看”，但尚无持久 Session 激活表，
查看正文不会将该包变成模型可调用。用户消息、steering 或 follow_up 的文本不会伪造显式选择。
普通模型可按目录自主调用允许的包。没有自动执行、模型可调用的 Skill 编辑工具、文件监听、
远程包安装或语义推荐。Compaction 后可重新查询目录，
按仍有效的 digest 重读；这不是持久化“已激活 Skill”的承诺。

## 验证

构建后执行 `npm run test:skills:built`；包括核心读取、Consumer、真实临时目录导入、
无会话 HTTP 读写、重启与 Client Model 生命周期。类型契约见 `type-tests/skills.ts`。
`node scripts/accept-skills-library-browser.mjs` 使用生产视图和确定性 transport 验证
桌面／窄屏、明暗主题、文件选择与导入交互；它不等同于真实 Host 浏览器端到端验收。
测试覆盖解析、来源冲突、路径／链接边界、分页一致性、取消、权限、模式控制、
上下文不可信边界和 Tool Consumer 的卸载；不代表真实 Provider 或浏览器验收。
完整快照和来源撤销另见 `node scripts/accept-skill-resource-snapshots.mjs`。
