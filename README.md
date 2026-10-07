# causal-weave

面向 Node.js 22+ 和现代浏览器的 TypeScript 多端因果消息 Channel。
ESM-only，运行时零依赖，持久化由调用方提供。
当前是 `0.1.0` 首次公开发布候选，采用 MIT 许可证；尚未上传 npm registry。

## 四个操作

- `send(message)`：验证真实因果依据，通过存储序号 CAS 原子登记，返回登记反馈。
- `read({ after, limit })`：用 Frontier 续读，按 channel 登记序号升序分页。
- `getState()`：返回当前合法历史的整体前沿。
- `watch(observer)`：变化通知及初始状态，返回同步、幂等取消函数。

```ts
import { createChannel, createFrontier, parseEndpointId } from "causal-weave";

const created = createChannel({ persistence: strategyForThisChannel });
if (!created.ok) throw new Error(created.error.reason);
const channel = created.value;

const endpoint = parseEndpointId("my-endpoint");
const empty = createFrontier();
if (!endpoint.ok || !empty.ok) throw new Error("Invalid endpoint or frontier");

const sent = await channel.send({
  endpointId: endpoint.value,
  frontier: empty.value,
  contentType: "application/json",
  content: new TextEncoder().encode(JSON.stringify([{ type: "example" }])),
});
if (!sent.ok) {
  // 根据 sent.error.code 处理竞争、输入错误、存储失败或结果不确定。
  report(sent.error);
}

let after = empty.value;
for (;;) {
  const result = await channel.read({ after, limit: 100 });
  if (!result.ok) {
    report(result.error);
    break;
  }
  await processMessages(result.value.messages);
  after = result.value.nextFrontier;
  if (!result.value.hasMore) break;
}
```

示例的 `report`、`processMessages` 和存储策略由应用实现，不属于本包。
消息内容和所有 Map / 字节返回值是隔离副本，可变输入不改变已核验事实。

## 消息与前沿

```ts
interface Message {
  readonly endpointId: EndpointId;
  readonly frontier: Frontier;
  readonly contentType: string;
  readonly content: Uint8Array;
}

interface RegisteredMessage extends Message {
  readonly hash: MessageHash;
  readonly sequence: number;
}
```

`frontier` 为 `ReadonlyMap<EndpointId, MessageHash>`，缺失维度是 bottom。
节点 hash 覆盖发送方、发送前沿、格式提示和内容，不含 channel、sequence、
协议版本、时间戳或自身 hash。
包含自身的因果前沿由 `frontier` 将本端项更新为 `hash` 推导，不重复保存。

发送本端位置必须是当前 tip；其他端位置可以落后，但不能比本端上一消息已观察位置倒退。
前沿必须闭合：引用 B1 时也覆盖 B1 的传递依赖，核心不自动补全。
hash 的先后按同端链祖先关系比较，不按字符串或登记序号排序。
fork 明确拒绝，不选赢家。

端 ID / contentType 是非空 Unicode scalar 字符串，不 trim、不改大小写、不归一化。
contentType 允许应用自定义，只提示格式，核心不验证内容真是 JSON / MIME。
hash 必须为 64 位小写十六进制 SHA-256。`parseEndpointId`、
`parseMessageHash`、`createFrontier` 提供运行时校验；brand 只防止编译期误用。

## PersistenceStrategy

完整类型由包入口导出，最小能力为：

| 方法 | 语义 |
| --- | --- |
| `getLatestSequence()` | 返回最新已提交序号，空 channel 为 0。 |
| `get(hash)` | 查询目标 channel 内登记记录，缺失是成功的 undefined。 |
| `scan({ afterSequence, throughSequence, limit })` | 按序号扫描 `(afterSequence, throughSequence]` 范围。 |
| `append({ expectedSequence, message, hash })` | 比较最新序号并原子追加，分配新序号。 |
| `watch(observer)` | 底层登记变化通知，返回幂等取消函数。 |

所有预期失败均为 `Result<T, E>`；异步操作为 `Promise<Result<T, E>>`。
策略不理解 frontier、端 tip、闭包、hash 校验或业务权限。
这些逻辑全部由 Channel 执行；策略无需提供 snapshot、withRead 或悲观锁。
本包不提供具体存储 adapter；测试中的内存策略仅作为测试夹具。

### 存储必须兑现的保证

1. 策略绑定一个目标 channel，不隐式查询其他 channel 的登记集合。
2. 所有追加共享同一个原子序号 CAS，支持多个实例 / 进程；不是各自的内存锁。
3. CAS 不匹配返回 `SEQUENCE_CONFLICT`，此次没有写入。
4. CAS 成功原样持久化 Message/hash，分配唯一、更大的安全整数 sequence，
   原子公开记录和高水位。不得只保存请求后就提前报告成功。
5. 已登记记录不变、不可删除；一旦高水位 S 可见，所有已登记 sequence <= S
   都可读取，不能迟到填补旧序号范围。允许序号间隙，但不可回退 / 复用。
6. 范围扫描完整且有序，最多返回 limit 条；不得用滞后副本隐藏已提交数据。
7. 序号耗尽显式返回 `SEQUENCE_EXHAUSTED`。写入失败必须区分确定未写入与结果不确定。
8. watch 必须报告注册 / 运行失败；不声称网络确认就是消息业务处理完成。

Channel 无法证明策略没有隐藏记录，无法保护绕过 Channel 的非法写入者。
删除 / GC / 改写历史需要另一个版本和保留规则，不适用于本版策略契约。
统一登记序号要求 channel 有统一排序点；本包不提供分布式共识。

## 发送反馈与竞争

`send` 成功值包括 `message` 和 `currentFrontier`：

- 精确重投返回原 hash / sequence，即使本端 tip 已有后继。
- CAS 成功后的 currentFrontier 由校验前状态更新本端项得到，不再读存储。
- 其中其他端消息可能未被发送者观察，不能替代发送依据。
- CAS 竞争返回 `CONCURRENT_MODIFICATION`，不自动重试或改写原消息。
- 再次发送原消息会重新核验；本端已前进时可能返回 `STALE_ENDPOINT_TIP`。
- `APPEND_OUTCOME_UNKNOWN` 表示可能已登记，必须用原 hash / 原消息核实，
  不能改前沿或内容生成另一个节点盲目重发。

发送成功只是登记成功，不是对端已读、审批、认知完成或业务回复。
channelId 的生成、路由、端身份和授权由上层负责。

## 读取与订阅

每次 read 独立，没有跨页 session。内部可以采用一个只追加历史截止位置；
合法 after 若比初选截止位置新，会重新选择包含它的截止位置，不报 session 错误。
每页返回所有端未被 after 覆盖的消息，包括本端，按 sequence 排序。
`nextFrontier` 累计 after 和本页所有消息，不等于最后一条消息的发送前沿。
`hasMore=false` 仅表示该页选定历史范围内没有剩余，随后可再次 read。
只有成功处理页内消息后，应用才保存 nextFrontier；读取不证明业务处理完成。

watch 先注册底层，再异步报告初始状态，通知可以合并。
状态读取失败进入 `onError` 后继续订阅；底层通知流失败报告并结束订阅。
取消后不再启动新回调，已开始的处理不撤销。
回调自身抛错会在独立 microtask 中作为异常暴露，不递归调用 onError 或吞错。
同步取消的策略必须自行兑现资源约定；本版不默认提供异步资源释放 API。

## 错误与资源限额

每个操作导出自己的直接错误联合，例如 `SendError`、`ReadError`、`GetStateError`，
以 `code` 判别，携带端 / hash / 预期和实际序号等必要信息。
已存历史问题统一为 `INVALID_HISTORY`，保留具体原因与证据；
策略接口违约为 `STRATEGY_CONTRACT`，不是普通存储 I/O 失败。
可预期失败返回 Result；未知程序缺陷仍 throw / reject，不广泛 catch。
错误不默认打印日志，不携带消息 content。

默认限制可通过 `createChannel({ persistence, limits: { ... } })` 覆盖：

| 限制 | 默认值 |
| --- | --- |
| ID / contentType UTF-8 字节 | 各 1024 |
| content 字节 | 1 MiB |
| 单个规范编码字节 | 2 MiB |
| frontier 维度 | 1024 |
| 单页消息 | 1000 |
| 单页规范编码字节 | 16 MiB |
| 单次完整扫描历史记录 | 100,000 |
| 单个操作的节点读取 / 访问计数 | 1,000,000 |
| 底层扫描批量 | 128 |
| 单个操作的消息体缓存节点 | 256 |

超限明确失败，不截断为成功。状态校验按批扫描，每个操作重新验证历史，
只保留有限消息体缓存、端 tip 和少量历史标识元数据。
首版不承诺大历史常数时间读取；长链 / 小缓存会增加祖先遍历，
达到访问限额时需调整 profile 或以后明确索引协议，不能跳过校验。

`encodeMessage`、`decodeMessage`、`hashMessage` 是高级纯编码工具，
不代表 channel 已接受节点。合法解码重编码字节一致，严格拒绝非法 UTF-8、
重复 / 乱序维度、错误前缀、截断和尾随字节。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec silvermoon check --worktree --audience agent
```

Silvermoon 只作为开发工具，通过 pnpm override 固定到支持 v2 的 Git commit，
不进入运行时依赖。本包不依赖 Silvermoon 的业务抽象。
测试用 Node 内置 runner；浏览器共享 smoke 入口为 `test/browser-smoke.mjs`，
经本地 HTTP 服务加载后调用 `runBrowserSmoke()`，无需 Node API。
许可证为 MIT；实际 npm 上传仍需单独确认，不执行自动发布。
