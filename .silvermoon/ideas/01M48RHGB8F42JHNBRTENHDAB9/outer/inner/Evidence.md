# 实施验证证据

## 环境与命令

验证日期：2026-10-07。
Windows；Node.js v24.12.0；pnpm 10.27.0；TypeScript 5.9.3。
包声明支持 Node.js 22+，本次实际执行环境是 Node.js 24，并未声称实际跑过 Node.js 22。

- `pnpm typecheck`：通过；包括 strict、noUncheckedIndexedAccess、
  exactOptionalPropertyTypes、noUnusedLocals、noUnusedParameters 及公共消费类型测试。
- `pnpm test`：34 项 Node 内置测试全部通过，无跳过。
- `pnpm build`：TypeScript ESM 与声明生成成功。
- `pnpm install --frozen-lockfile`：通过，可复现锁文件。
- `import("causal-weave")`：自引用 exports 加载成功，8 个预期运行时导出。
- `npm pack --dry-run --json`：16 项，仅 README、package.json、dist JS / 声明；
  未实际生成发布包，也未执行 npm publish。
- `pnpm exec silvermoon check --worktree --audience agent`：通过。
- `pnpm exec silvermoon check --staged --audience agent`：实现候选通过。
- `pnpm exec silvermoon check --remote --audience agent`：实现提交
  0dee19576ffd3b76b4946a671cd659558cbfa618 已进入 main，远端检查通过。
  本证据更新自身也须重新通过 staged / remote 检查，才作为最终可验收候选。

pnpm 提示 Silvermoon 间接原生依赖的 build scripts 未启用；
没有自动批准执行这些脚本。本次所需 Silvermoon v2 检查实际通过，
不影响 causal-weave 的零依赖运行时。

## 功能与故障覆盖

- 固定二进制向量与 Node 独立 SHA-256 对照；
  内容、发送端、前沿、contentType 敏感性及 channel / sequence 非敏感性。
- UTF-8 字节序、BOM 保留、不归一化、孤立 surrogate、重复维度、
  全部截断位置、尾随字节、非法前缀、乱序及分配前限额。
- 空 channel、新端、多端、落后对端位置、传递覆盖后继位置。
- 未知引用、端不匹配、不闭合、本端 tip 过期、观测倒退。
- 同端与不同端多实例竞争：测试 barrier 强制相同校验前态；
  一次成功一次明确竞争，不自动重试，不产生分叉。
- 精确重投保留原序号，即使本端有后继；成功登记后无存储读取步骤。
- 确定回滚、写入成功响应丢失、不可信登记回执、程序缺陷未被吞掉。
- 小扫描批次 / 小缓存、非全局前缀 Frontier、空页、hasMore、
  分页间追加和读取期间追加。
- 确定性伪随机三端 30 消息模型：独立计算因果集合差，
  从四种起点随机分页，逐条验证顺序、不漏不重及最终前沿。
- 安全整数耗尽、序号间隙、精确历史数量限额、访问限额与页字节限额。
- hash 损坏、缺依赖、fork、依赖登记顺序、已存观测倒退 / 闭包错误、
  scan 违约、错误 get hash 和非法存储冲突回执。
- watch 初始状态、通知合并、注册期间写入不漏通知、状态读取失败后恢复、
  底层通知失败终止、幂等取消和计算状态期间取消。
- 输入 / 返回 Map 与 Uint8Array 修改不会改变存储事实。

## 真实浏览器验证

在本地临时 HTTP 服务加载最终 dist，不使用 Node API；
服务已停止，临时服务脚本未放入仓库。

实际浏览器：VS Code 集成 Chromium 150.0.7871.250 / Electron 43.7.3。
调用 test/browser-smoke.mjs 的 runBrowserSmoke()：

```json
{
  "checks": 8,
  "hash": "c4e1049cb85b122f3282c92a1114a41d33e899d580c5543f2bd7720f6590983d",
  "messages": 2
}
```

覆盖 SHA-256 固定向量、严格解码、尾随拒绝、发送、Frontier 两页读取、
精确重投及初始订阅 / 取消；相同共享 smoke 在 Node 中也通过。
未声称测试 Safari / Firefox 或全部浏览器版本。

## 尚未执行

真实数据库 / 网络策略的集成、分布式协调、性能基准、
许可选择、npm 发布与现实世界部署均未执行，也不属于本次实现验收证据。
测试内存策略仅是夹具，不作为生产存储策略导出。
