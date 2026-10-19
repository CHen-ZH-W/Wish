# 插件私有状态协议

这是插件自身业务状态的持久化域。管理偏好、pending、操作记录仍由 `ManagedPluginStore` 管理；对话、工具结果及任务进度仍由 Session / Runtime 管理。这里存放记忆索引元信息、策略内部数据、持久化游标等，三者不混存。

## 插件接入

无状态插件维持 `{ "mode": "stateless" }`，不创建 writer、不实现迁移、不打开持久化目录。有私有状态的插件显式打开一个句柄；恢复成功以后才发布服务：

```ts
import type { Context } from '@deepseek-ai/cordis';
import { PluginWorkOwner } from 'wish/plugins/work-owner';
import type { PluginStateValue } from 'wish/plugins/state';

declare module '@deepseek-ai/cordis' {
  interface Context { counter: { increment(): Promise<number> } }
}

export default {
  name: 'counter',
  async apply(ctx: Context) {
    let total = 0;
    const state = await ctx.root.pluginState.open(ctx, {
      identity: { pluginId: 'counter', pluginVersion: '2.0.0', schemaVersion: 2 },
      readableVersions: [2],
      migratableVersions: [1],
      validate(value: PluginStateValue) {
        if (!value || typeof value !== 'object' || !('total' in value) ||
            !Number.isSafeInteger(value.total)) throw Error('invalid counter state');
      },
      snapshot: () => ({ total }),
      restore: saved => { total = (saved.value as { total: number }).total; },
      migrate: saved => ({ total: saved.value as number }),
    });
    new PluginWorkOwner(ctx, { code: 'counter', codeReload: true });
    ctx.provide('counter', {
      increment: () => state.run(() => { total++; return total; }),
    });
  },
};
```

对应 Manifest：

```json
{ "state": { "mode": "versioned", "schemaVersion": 2,
             "readableVersions": [2], "migratableVersions": [1] } }
```

Manifest 表达准入声明，实际 writer 必须与声明的插件 ID、格式版本和兼容范围一致。声明迁移范围还必须提供实际 `migrate` 函数。缺失实际 writer 的版本化插件不能通过在线晋升的 conformance 检查。独立嵌入使用 `PluginStateRegistry` 与 Provider port，可显式传入稳定 key 和产物摘要。

每个 Fiber 只拥有一个私有状态句柄，key 为 `qualified Entry ID/pluginId`。第二个 writer 在恢复前即拒绝。所有状态变更应在 `state.run()` 内执行；该方法串行执行变更并等待快照耐久化后返回。`flush()` 等待先前变更完成并落盘。OwnerRegistry 在普通工作排空后等待该屏障，再允许卸载或替换。旧句柄被关闭后不能继续写入。句柄由 Cordis effect 关闭，不需要插件另行编写重复的 dispose。

`snapshot`、`restore`、`validate`、`migrate` 只处理数据，不调用自己的句柄或注册表，不进行外部副作用；相同句柄的 `run` 也不嵌套调用 `run/flush/close`。插件必须保证这些回调能结束。把长期工作留给已有 Owner 的 drain / abort 协议。

## 格式与切换边界

每个不可变快照记录格式版本、逻辑 key、写入插件版本、Loader 观察到的入口模块 SHA-256、配置摘要、状态格式版本、前一快照摘要及数据摘要。摘要验证失败或数据校验失败时拒绝恢复。入口摘要按原生模块 callback 捕获，HMR 补偿重用旧 callback 时仍保留旧代码身份。多文件插件还应通过现有 Profile 的代码文件 / 依赖锁身份追踪整个发布产物；入口摘要本身不代表全部传递依赖。

原子 KV 与 CAS 由现有 `StorageDomain` 和 File Backend 提供；索引与快照位于独立的 `plugin-private-state/*` namespaces。Root 持有 Provider，业务 Storage 插件替换不会提前关掉私有状态存储。默认目录是 `WISH_DATA_DIR/plugin-state`，未设置时是 `~/.wish/plugin-state`。

受控配置变更和 HMR 的步骤为：

1. Root 队列与 Step 边界锁定本次变更，记录私有状态事务。
2. 旧 Owner 关闭 admission，排空调用；最终快照 fsync 后成为本次变更的保留检查点。
3. 后继 writer 读取旧状态，直接 restore，或在声明的范围内执行 migrate。迁移结果只写入本事务的 staged heads。
4. 新服务完成激活和 conformance 检查，Root 成功 receipt 耐久化后，才原子发布 staged heads、重开 Step。
5. 激活失败先阻止候选继续写入，再恢复旧实现及旧检查点；不能证明恢复成功时保留恢复要求和执行屏障。

首次启动同样暂存恢复结果，防止迁移成功后插件初始化失败污染旧状态。进程崩溃后按已有 Root receipt 判断 staged heads 是否已经提交；只恢复数据，不重放业务调用或自动重试迁移事务。显式关闭、停用及重启使用相同的 flush / restore 契约。

`readableVersions` 表示 restore 能直接读取的格式；`migratableVersions` 表示必须经过 migrate 转换的格式，两者不重叠。普通升级不兼容时会拒绝。操作员明确回滚时，Host 的 `restorePreviousState: true` 仅允许沿已提交快照历史查找完全相同产物、插件版本和配置的旧检查点，找不到即拒绝；这会回退升级后产生的私有数据。它不能用来把任意旧数据交给一个新产物。配置中不提供自动降级开关。

Candidate 沙箱验证必须真实打开匹配 Manifest 的 writer；显式批准后，Root 使用上述协议进行有状态晋升、失败补偿和回滚。Benchmark 使用独立数据目录，不复制生产私有数据。行为评测通过不代表覆盖了所有历史数据，实际激活仍逐份校验 / 迁移，失败则恢复旧状态。

## 持久性及边界

- File Provider 的进程锁阻止多个 Host 写入同一目录。Linux 仅在相同主机、boot 和 PID namespace 内证明旧进程死亡后回收锁；未知所有权、外来环境或非 Linux 的遗留锁拒绝抢占。它不采用会过期并夺走活跃 writer 的租约。
- 快照只接收有限 JSON 数据，最大 8 MiB、深度 64；schema envelope 之外的任意对象、函数、非有限数与循环引用均拒绝。索引同样有 8 MiB 上限。
- immutable snapshots 保留版本回滚的历史，当前不自动 GC；一次显式回滚最多查找 10000 个检查点。高频大数据应保留在专用数据 Provider，快照存其元信息或游标。
- Snapshot 写入失败不会发布新 head；索引持久化失败会封闭写入，等待恢复。失败清理不会伪造成功释放写所有权。
- Snapshot 不撤销文件写入、进程启动和网络请求，也不保证外部操作恰好一次。此类能力继续使用各自操作日志、幂等键及恢复策略。

## 验证

构建后运行 `npm run test:plugin-state:built`，覆盖快照校验、单写入者、持久化屏障、升级、补偿和回滚；测试使用临时目录与本地模拟模型服务。
