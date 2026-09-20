# Storage

Storage 把持久化基础设施拆成三层：Cordis `StorageHub` 管理具名 Backend，Backend 暴露
KV 等原语 facet，Domain Form 再把原语映射为带 schema 的业务状态。业务服务仍然依赖自己的
Port，不直接依赖文件布局或 Cordis Context。

```text
StorageHub -> selected StorageBackendService -> KV / Blob / Journal facets
                                             -> StorageDomain -> business Store Port
```

## 模块所有权

`src/storage/` 只拥有通用 Storage 契约、Domain Form 和 Backend Provider：

```text
src/storage/
├── backend.ts / binding.ts / service.ts / errors.ts
├── kv.ts / blob.ts / journal.ts / domain.ts
└── providers/file/
    ├── backend.ts / paths.ts / plugin.ts
    └── kv.ts / blob.ts / journal.ts
```

使用 Storage 的业务适配器归业务能力所有：ModelCatalog 位于 `src/models/persistence/`，
Tool Result Archive 位于 `src/tools/results/`，Session File Provider 位于
`src/sessions/providers/file/`。目录所有权不会改变 Cordis 的 Definition/Provider/Consumer
组合关系。

## Storage Hub

`StorageHub` 自身不读写数据。它负责注册唯一 Backend ID、验证 Provider 声明的 facet 和
capabilities、按 ID/facet 解析以及在 Provider fiber 卸载时退休 Backend。退休顺序固定为：
先从 Hub 删除注册并拒绝新获取，再等待已有 `StorageBackendLease` 释放，最后关闭物理
Backend。重复注册、未知 Backend 和缺少 facet 分别使用稳定的 `storage_conflict`、
`storage_backend_not_found` 和 `storage_facet_unavailable` 错误。

`backend()` / `resolve()` 适合即时检查或不跨生命周期边界的访问。任何会把 Backend/facet
保留到异步任务、Run 或 Application generation 中的消费者都必须调用 `acquire()`，并由同一
资源所有者在排空工作后调用 `lease.release()`。Lease 可以继续作为
`StorageBackendResolver` 传给 Domain/业务适配器；从 Lease 派生的子 Lease 有独立释放责任。
Provider 退休后已有 Lease 仍可完成已接纳工作，但不能再派生新 Lease。

`StorageBackendRegistration.snapshot()` 只读返回这一注册代次的 state 和 lease 数，
Hub 删除注册后仍可观察 retiring／closed／failed，不能用 `has() === false` 推断关闭成功。
物理 close 失败明确记录 failed；快照不释放 Lease，也不返回 Backend 路径或数据。
File Provider 在自身装配边界可选注册 Host 生命周期查询：有 Lease 时报告 drain，
退休中、已关闭或关闭失败时报告 blocked。查询不控制关闭顺序，不引入 Storage 对插件管理的
必需服务依赖；实际退休仍由上述 Hub/资源所有者协议完成。

`registration.suspendAcquisitions()` 是可组合的同步准入限制，返回幂等撤销函数；限制期间
Hub 的 acquire/backend/resolve 和已有 lease 的子 acquire 拒绝，已有 lease 仍可完成
已接纳的工作。撤销一个限制不解除其他限制，也不会复活退休注册。File Provider 的可选
stop guard 使用该接口封住准入，再复用 `unregister()` 等待 lease 排空与物理关闭。
等待超时不释放别人的 lease、不删除数据，也不宣称清理成功。长期保留无 lease 的 raw
Backend/facet 仍是违反上述所有权契约的调用；管理层不能从注入图发现这种隐藏引用。

Backend 的 `writerConcurrency` 必须明确为：

- `process-local`：只保证同一进程内的写入/CAS 串行化；
- `multi-process`：Provider 承诺跨进程并发语义。

当前 File Backend 同时提供 KV、Blob 和 Journal；三种 facet 共用 Backend 生命周期，但不把
各自的数据模型混在一起。

默认 Provider 还提供 `storageBackend` 选择服务，并透传同一套 Lease 获取契约。业务
Provider 注入这个 Definition，而不依赖 `storage-file`；切换到 SQLite/remote 时只需换
Provider。选中的 Backend 卸载后，
ModelCatalog Domain、ToolResultArchive 及其下游会由 Cordis 自动转为 PENDING，而不是继续
持有一个内部缺少 Backend 的 Hub。

## KV 契约

KV 保存 `Uint8Array`，不认识 JSON 业务对象。`namespace` 和 `key` 是逻辑身份，不是路径。
`put` 和 `delete` 必须显式给出 `any`、`absent` 或 `revision` precondition；不存在用
`undefined` 同时表达覆盖、仅创建或 CAS 的情况。成功返回即 Provider 的 durability point。

Provider 必须复制输入和输出字节，关闭后所有操作返回 `storage_closed`。CAS 失败使用
`storage_conflict`；持久化格式损坏使用 `storage_corruption`；底层 IO 失败使用
`storage_unavailable`。事件不能早于成功的 durable commit。

## File Backend

`FileStorageBackend` 的根目录在 Provider 创建时显式解析。磁盘布局仅使用 namespace/key 的
SHA-256：外部 Session ID、Workspace ID 或用户 key 不会直接进入路径。逻辑身份保存在
envelope 中，并在每次读取时和哈希路径交叉验证。

一次写入按以下顺序完成：

1. 在目标文件同目录用 `open(..., "wx")` 创建临时文件；
2. 写入完整 envelope 并 `fsync` 文件；
3. `rename` 原子替换目标；
4. `fsync` 父目录；
5. 返回新 revision。

失败清理临时文件时不会覆盖原始异常。删除成功后也会同步父目录。Backend 对同一个逻辑 key
执行进程内串行化，因此 CAS 在单进程内可靠；当前明确不支持多个进程同时写同一个根目录。
默认 Cordis 组合注册 Backend ID `file`。路径优先取 `WISH_STORAGE_FILE_ROOT`，否则在设置
`WISH_DATA_DIR` 时使用其 `storage` 子目录，最终回退到 `<home>/.wish/storage`。

## Domain Form

`DomainSpec<Request, Value>` 拥有 domain ID、schema version、global/keyed 形态、Backend
要求、codec、验证和迁移函数。`resolve(request)` 在 IO 之前显式确定 keyed identity 和
默认值，返回一个不可变 Domain handle。

Domain payload 使用独立 envelope 记录 domain ID 与 schema version。读取旧版本时只执行
该 Domain 声明的迁移；未知新版本、无迁移路径、非法 envelope 或业务验证失败都按
`storage_corruption` 失败。一个 domain key 的写操作按序执行；写入顺序固定为 Backend
durable commit、更新内存缓存、最后发布 commit event。事件观察失败不会把已经成功的提交
伪装成写入失败。

## Domain consumers

`DomainModelCatalogStore` 把现有 `ModelCatalogStore` Port 映射到 global
`models/catalog` Domain，保持业务 schemaVersion 为 1。`ModelCatalog` 无需知道 Hub、KV、
文件路径或 Provider。旧的 `FileCatalogStore` 仍保留；两种 Store 运行相同的 diff、sync、
malformed state 和 Provider last-known-good 行为测试。这里不会静默导入旧文件；旧数据
只能通过显式 importer 导入。
默认 `model-catalog-storage` Cordis Provider 把这一 Store 绑定到选中的 Backend；canonical
Catalog 数据仍在 Domain/Store 中，不放入 Cordis Context。

这些实现位于 `src/models/persistence/`。Model Catalog 是第一个 KV Domain；其他业务消费者
也必须在自己的模块中持有业务 schema、迁移和 Port adapter。

## Blob

Blob 保存不可变 `Uint8Array`，`put/get/stat` 使用包含 namespace、opaque locator、SHA-256
和 size 的稳定引用。File Blob 的 locator 使用 `sha256-v1:` 协议而不是文件路径，逻辑
namespace 经过哈希映射；写入仍使用同目录临时文件、文件 fsync、原子 rename 和目录 fsync。
相同 namespace/content 幂等返回同一引用，已有内容与引用冲突时 fail closed。

Tool Result Archive 是 Blob + KV 的业务消费者，其协议、兼容读取和 Cordis Provider 由
`src/tools/results/` 拥有。Cordis Provider 的每次 `open()` 都 acquire 一个 Backend lease；
Context/AgentLoop/RunGeneration 负责在活动 Run 排空后释放，不会把裸 facet 留在退休后的新
generation 中。

## Journal

Journal 按 namespace 打开，提供原子 batch append、单调 cursor、revision CAS、batch
idempotency key、流式 read、显式 flush 和 close。File Journal 的一个 JSONL 行是一整个事务，
包含前序 revision、cursor 起点、全部 payload 和校验和；提交返回前 fsync 文件。完整但损坏的
行始终返回 `storage_corruption`。无换行的 torn tail 默认 fail closed，也可由 Provider
显式配置为 `truncate`；修复会截断到最后一个完整事务、同步文件和目录并发布 warning。

同一进程中仍活跃的 namespace handle 会复用，以维持单 writer 串行化；handle `close()`
后不会被下一代 Cordis Provider 复用，后续 `open()` 会建立新 handle。

Journal Backend 不认识 Runtime lifecycle、Trace、Usage 或 Audit 的业务状态。当前
`src/core/runtime/durability/` consumer 自己维护
`prepared -> dispatched -> terminal/interrupted` 状态机，并只把编码后的领域事件交给
Journal。它 acquire Backend lease、要求原子 batch + fsync，在显式恢复扫描中产出
`needs-reconciliation` 等业务分类；这些语义没有下沉到 Storage。

`src/models/pricing/` 同样把每次 Provider attempt 的 started/terminal 领域事件编码后写入
独立 Journal；Storage 不解释 provider、model、usage、price quote 或 cost。Pricing Provider
持有 Backend lease，负责启动时恢复未终结 attempt，并把 durable record 通过
`modelAttemptLedger` Cordis Service 暴露给 Models 组合。

SessionPersistence 是独立业务 seam，没有退化成 KV 或 Journal；Definition、Provider 和磁盘
格式由 `src/sessions/` 拥有。

## 验证

```bash
npm run typecheck
npm run test:storage
npm run test:runtime-durability
```

可复用 KV conformance 位于 `scripts/support/storage-kv-conformance.mjs`。所有替代 KV
Provider 都必须通过同一套测试。
