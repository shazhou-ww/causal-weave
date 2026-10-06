# Implementation

批准的 Ideal revision：dac676df3580e0714027fa3b983bf24c4704be07。
不修改 Ideal，不自动验收实现，也不发布 npm。

## 实现选择

用户在实施开始时确认：pnpm、ESM-only、TypeScript、Node 内置测试；
序号使用安全整数 number；contentType 为非空 UTF-8 自定义字符串；
Frontier 使用 ReadonlyMap 并提供解析 / 创建辅助函数。
watch 先注册，再异步报告初始状态；状态读取失败报告后继续，
底层订阅失败报告并结束；取消同步幂等。

目标为 Node.js 22+ 与支持 Web Crypto、TextEncoder、TextDecoder、Map 的现代浏览器。
运行时代码不导入 Node 或 Silvermoon；Silvermoon 仅开发依赖。
package 标记 private，许可和公开发布留待后续明确授权。
用户授权 pnpm override 将 Silvermoon 开发工具固定到
cfabf52936b7372d45f43e07ab813a2271fe4938，以使用未发布的 v2；
不依赖本机路径、不修改 Silvermoon 源仓库。

端 ID 与 contentType 拒绝空值和孤立 surrogate，不 trim 或归一化。
hash 为 64 位小写 SHA-256 十六进制。提供有限默认资源 profile，
在 Channel 创建时允许覆盖；超限显式 Result 错误。
所有预期错误为直接接口 / 联合类型，不采用映射类型注册表。

## Steps

### I-S01: 建立包与公共类型

建立 ESM 编译、类型声明、Result、Message、RegisteredMessage、
Channel 和低层 PersistenceStrategy；导出少量 ID / Frontier 创建辅助函数。

### I-S02: 实现规范编码与完整性

实现 Ideal 的长度前缀二进制布局、UTF-8 字节排序、严格解码和 SHA-256。
编码包含 contentType，不包含 channel、sequence、版本或自身 hash。

### I-S03: 实现历史校验与 Channel 操作

按存储高水位分批扫描，保留有限节点缓存而不一次加载全部消息内容。
验证 hash、登记序号、依赖、端链、闭包与单调观察。
send 用 expectedSequence CAS，无自动重试；read 每次独立，
累计 Frontiers 分页；getState 与 watch 使用同一校验路径。

### I-S04: 验证故障与并发并完善使用文档

测试策略仅存于 test，不发布具体存储 adapter。
覆盖多端、竞争、响应丢失、损坏历史、取消订阅、数据副本及跨运行时编码。
README 记录策略语义、限额、错误以及使用流程。

## Acceptance criteria

### I-AC01: 类型与构建通过

pnpm typecheck、pnpm build、pnpm test 成功，声明与 ESM exports 可消费；
运行时无 Node / Silvermoon 导入，不发生 npm 发布。

### I-AC02: 编码与内容地址准确

固定字节 / hash 向量、严格解码反例、键排序和字段敏感性测试通过；
验证 contentType 参与 hash、channel / sequence 不参与。

### I-AC03: 因果与登记规则准确

测试允许落后的对端位置，拒绝 tip 过期、倒退、未知引用、不闭合与 fork；
精确重投复用原序号，竞争明确失败，响应丢失保留不确定结果，
成功登记后不额外读取状态。

### I-AC04: 分页与订阅可靠

测试每页限额、不漏不重、合并 after 的进度、分页间追加、初始通知、
通知合并、状态故障与底层订阅故障、幂等取消及可变数据隔离。

### I-AC05: 候选可追溯

README 与测试记录实际行为，ledger 仅镜像步骤与标准；
Silvermoon worktree / staged / remote 校验通过，实施候选进入 primary，
但仍等待用户对精确 implementationRevision 的验收。

## 实施结果

实现入口为 src/index.ts。src/types.ts 直接定义公共结果与错误类型，
src/codec.ts 实现编码 / 解码 / hash，src/history.ts 按批验证历史并保留有限缓存，
src/channel.ts 编排四个操作。没有添加公开 Endpoint、导入或持久化 adapter。

README 记录完整策略语义、默认资源 profile 和运行限制。
每个操作重新扫描核验历史，首版不承诺常数时间读取；
长链祖先遍历可能达到显式访问限额，不跳过校验。
固定读取边界仅为单次操作内部实现，不是跨分页 session。

验证过程及结果见 [Evidence.md](./Evidence.md)。
只将实现标为可验收候选；Ideal 内容及 acceptIdeal 事件均未改动。
