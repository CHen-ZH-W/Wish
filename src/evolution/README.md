# Evolution

Evolution 是可选的 Cordis 插件组，负责从已提交任务轨迹或人工目标提出 Harness 修改，生成候选，复用 Candidates 的隔离构建、测试与生命周期验证，并持久保存过程和人工反馈。Core、AgentLoop、Sessions 不依赖该领域。

## 启用与使用

设置 `WISH_EVOLUTION_ENABLED=1`，沿用现有 Wish CLI 或 WebUI 启动方式。默认不加载这些插件。启用后不会自行调用模型或发布候选；运行观察器只读取已提交事实并保存到独立的 Evolution namespace。

WebUI 在会话右侧栏的「开始」或「+」中提供「自进化」入口。填写问题并选择生成方式，可查看证据、修改假设、候选源码、轮次差异、技术验证状态与实际用量，并暂停、取消或给出下一轮反馈。源码按准确 digest 单独读取，状态轮询不反复传输整包和原始轨迹。界面不以分数或效果评测推进；金额未知和账本不完整分别展示。

```sh
WISH_EVOLUTION_ENABLED=1 wish evolution begin '让修改后的验证步骤更明确'
WISH_EVOLUTION_ENABLED=1 wish evolution begin '增加一个受限的代码整理工具' tool runtime
WISH_EVOLUTION_ENABLED=1 wish evolution list
WISH_EVOLUTION_ENABLED=1 wish evolution show <campaign-id>
WISH_EVOLUTION_ENABLED=1 wish evolution pause <campaign-id> <revision>
WISH_EVOLUTION_ENABLED=1 wish evolution recover <campaign-id> <revision>
WISH_EVOLUTION_ENABLED=1 wish evolution experiences
WISH_EVOLUTION_ENABLED=1 wish evolution genes
```

`begin` 生成受限基线与一项改进任务，并等待当前轮结束。`continue <id> <revision> 'feedback'` 根据明确反馈生成下一轮。`create <spec.json> <request-id>` 接受完整规格但不启动；随后用 `run <id>` 执行。相同创建身份与相同规格返回原记录，不同内容冲突。CLI 会打开本地 Host，不能与另一个写入 Host 同时争用同一数据目录；运行中的 WebUI 应使用页面入口操作。

## 流程与证据

默认流程为 `evidence → generate → candidate → feedback → awaiting-external-validation`。最后一个状态表示候选已具备技术验证记录，效果评测尚未接入；它不表示候选更好、已获批准或已正式部署。手动目标也是有效输入，失败原因会保留为假设。

支持 Prompt、Skill、Tool 和通用插件。Prompt 由 Host 封装受限文本；Skill 由 Host 解析完整 UTF-8 包并封装只读 FrozenSkills 来源。修订时可返回完整基线 digest 与资源 patch，Host 保留未修改的脚本、引用和资产。用户本地同名 Skill 保持既有优先级，不自动覆盖原文件。Tool 必须声明 `evolution-target.json`、注册命名空间内的实际工具，Host 将准确工具名加入候选 Profile；只声明 Manifest 而未注册无法通过。所有对象沿用 Candidates 准入；Workflow、Kernel、Boot 和数据 schema 尚无专属演进契约。

`structured` 默认只调用受限 JSON 生成，不提供工具。`runtime` 复用既有 Application/AgentLoop，在独立 Node Host 的私有目录读取证据、编写代码、调用现有文件和原生 Bash 工具。生成 Profile 与被研究的基线分别冻结；模型不变、无隐式重试或 fallback，最多每轮 8 次请求、总共 3 轮/24 次请求。取消先中止 Runtime，再清理进程组；导出真实 Session/Run、账本、提交事件和轨迹摘要。生成任务不会创建 Experiment、运行效果断言或给出任务通过判定。支持标准模型协议，自定义协议需单独适配。

TaskTrace 关联提交事件、Session/Run、模型账本、Prompt digest、完整工具归档回执与可选独立验证结果。Host 的 `recordRunProvenance` 固定数据来源和任务身份，`recordTaskOutcome` 接受独立验证回执；来源不能在归档后重分类。相同 Run 的补充事实保留历史，但生成视图选择含独立结果的完整版本。Run completed 和助手自述不产生任务 passed；held-out 和 Evolution 自身轨迹禁止进入普通生成数据。

Observer 区分环境、权限与待定位的问题，并识别跨任务的同输入工具重复、已计量高 Token/请求数、按显式币种门槛判断的高成本。工具重复由已提交调用参数与真实 dispatched 事件关联，调用 ID 不参与重复指纹。成功任务也能形成效率提案。每项诊断保留替代解释；缺失账本、未知成本和单纯助手自述不会成为收益证据。

诊断阈值由 Evolution 插件配置 `diagnosticMaxModelCalls`、`diagnosticMaxTokens`、`diagnosticRepeatedToolCalls` 和 `diagnosticMaxCostByCurrencyJson` 控制；成本配置例如 `{"CNY": 2, "USD": 0.5}`，逐币种判断。

Controller 保存 intent、固定操作身份与独立阶段回执日志，支持 revision CAS、轮次谱系、请求/Token/分币种预算、超时、取消和迟到结果检查。回执先于 Controller 确认落盘；已知结果在恢复时核对，不重新调用模型。已确认失败保留账本，可在预算内按明确反馈开启新轮；未知结果继续 reconciliation-required。相同源码内容会在重复技术验证前停止。未知金额保持 null，不隐式换汇或记为零。

后台触发插件默认关闭。`WISH_EVOLUTION_TRIGGER_MODE=advisory` 只展示重复问题建议；`automatic` 才允许派发研究，且只允许 Prompt 目标、Harness 类假设、至少三个独立任务、0.8 置信门槛、每次一个研究、每小时冷却及每天三次配额。用户有活动 Run 时等待。当前启发式诊断最高置信度为 0.5，因此默认门槛下保留建议；调整阈值属于 Host 配置。派发身份、未知结果和并发名额持久保存，重启不会盲目重发；任务暂停或待核对时保留名额。自动研究仍不授权正式发布。

后台调度还检查当前研究占用、近 24 小时已计量请求与 Token、下一次研究的预算预留、模型配置和剩余磁盘。默认日预算 9 次请求/96,000 Token，磁盘保留 64 MiB；不完整账本会阻止新的自动派发。Host 配置可调整，不把模型置信度当作资源可用性。Owner 关闭先停止派发，取消并排空自有调用，最后释放存储。正式产物仍由 Root 独立管理。

## 资源与外部评测边界

Evolution 的基线和生成 Profile 均显式捕获完整 Skill 资源与空 Memory 初态。独立 Profile API 也允许冻结 accepted Memory；Worker 使用实际私有资源 Provider，每步核对完整 Skill 组合，拒绝资源缺失、漂移或动态 Provider。旧 Profile digest 兼容，资源缺省明确是 legacy-unfrozen。

`ExperienceWiki` 持久保存证据、假设、相互矛盾的经验及人工审核记录。知识积累不等于 Skill 修改；拒绝提案不删除其经验。进入生产 Memory 时把经验、审核记录和矛盾作为带来源的笔记交给后台自动整理，不再产生
pending candidate；整理仍需保留假设和实际验证之间的区别。`experience-record/review`、`gene-propose` 与只读列表供 Host 操作，未向模型暴露接受或发布能力。

Skill 元数据支持 Planning/Functional/Atomic 向下依赖；紧凑策略基因保存适用条件、推荐动作、结构化警告、经验和 Skill 版本身份，版本与父摘要固定，状态始终为提案。同基线研究 API 支持有界分析和分层归并，保存局部提案与冲突；当前自动流水线采用逐轮生成，批量分析需由 Host 发起。读取、调用、执行、独立成功分别计账，成功计数要求同一包/Run/Task 有执行和验证回执；调用接口不代表所有生产脚本已能自动归因。

`external-evaluation.ts` 仅定义版本化请求、回执和 not-requested/waiting-external/completed 状态。它不建立网络连接、运行 Docker 或给出分数，也不将外部结果自动转换成发布授权。评测机器与真实外部模型的效果验证需要单独接入。

正式发布继续要求原 Candidates 的完整评测证据和精确 CandidateReview 审批。当前交付停在可追溯的技术候选；真实 Coding 效果比较、组合消融、发布后新 Run 实际使用的完整组合验证和生产回滚闭环尚需独立接线，不能由加载成功代替。

## 验证

```sh
npm run typecheck
npm run test:evolution
npm run test:evolution:browser
```

领域、资源与客户端专项覆盖幂等、CAS、晚结果、恢复、来源撤销及展示真实性。集成使用确定性模型输入与真实 Linux 候选验证；浏览器使用真实 Host 与 Chromium。它们不构成外部评测机、真实模型质量提升或生产部署证明。
