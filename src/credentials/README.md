# Credentials

凭据是独立基础设施，不是普通 Settings 字段，也不是 Models 配置值。`Credentials` 只按公开
引用名解析、描述、写入和删除密钥；Browser DTO 只包含 `configured / source / writable`，
任何读取接口、事件、错误或操作回执都不返回密钥值。

优先级为启动环境高于受管文件。环境值表达本次进程的显式部署意图，网页只能看到它已配置且
只读；没有环境值时，WebUI 可以写入管理目录下的 `credentials.json`，运行时下一次 Provider
调用会按引用重新解析。删除受管值后回到缺失状态，不修改 `process.env`。

文件 Provider 使用 0600 文件与临时文件、原子 rename、目录 fsync 和进程独占 lock。已有文件
若允许 group/other 读取会拒绝启动。文档解析错误只报告稳定 code，不引用包含密钥的源码行。
API 密钥去除首尾空白后必须是非空可打印 ASCII；`NAME=value`、整体引号、空格和换行被拒绝。

管理 Host 提供批量脱敏描述及只写 set/delete。凭据提交仍要求同源管理 token；变更只发布失效
通知，由消费者重读状态。Models 只是凭据 seam 的消费者：公开配置保存引用，Provider 调用时
才解析值。

验证入口：`node scripts/accept-credentials.mjs`（先 build）以及
`node scripts/accept-managed-config-webui.mjs`。
