# causal-weave：以 Channel 为核心的多端因果消息 API

## 意图

设计一个面向 Node.js 与浏览器的独立 TypeScript 包 causal-weave。
核心对象是 Channel：发送消息、分页读取、查看状态、订阅变化。
数据类型与底层机制服务于这四个操作，不要求普通调用者编排编码、校验和提交计划。

Channel 可以挂接持久化策略，但包不包含具体数据库、文件系统或网络实现，
也不包含 Silvermoon 业务代码。
本文仍是讨论草案；发布、修改具体设计不等于批准整个 idealRevision。
当前不实施库、不迁移 Silvermoon、不发布 npm。

## 背景

最初需求来自 Silvermoon 的多端交互，但公共模型不包含 ideaId、审批命令、
生命周期、upstream/downstream 或业务 reducer，也不限定两个端。
内容寻址节点、多单写者链、稀疏因果前沿与每端 CAS 是内部正确性基础，
不是调用者必须逐项操作的顶层接口。

来源仅供追溯：shazhou-ww/silvermoon 的 idea-event-merkle-dag，
ULID 01M4868ZD9M9C1WV6XEXYCX264；primary commit
683c0ca97030b32acc69c666d0833d65972affbc，Ideal revision
d5e8eb251567eb60bd4af21fb280b0b0c5944e62。旧双端候选与分段设计不构成本包契约。

## 期望结果

应用取得一个已路由到目标 channel、挂接持久化策略的 Channel，
即可明确发送方和真实因果依据，发送消息并取得登记反馈。
读取以 Frontier 为续读游标，按 channel 内稳定登记顺序分批返回。
调用者可以查看当前前沿、订阅变化并取消订阅。

消息 hash 表示内容地址；登记序号表示该消息在某个 channel 的位置。
两者职责不同，登记顺序不冒充真实时间或业务处理完成。

## 范围

### 范围内

- Channel 的 send、read、getState、watch。
- 可挂接的持久化策略边界：一致读取、原子条件登记、稳定序号、变化通知。
- 规范编码、严格解码、SHA-256 完整性核验和精确相同节点重投。
- 端链、稀疏前沿、祖先关系、因果闭包、倒退与 fork 校验。
- Frontier 分页及错误、资源限额、数据所有权的公共契约。

### 范围外

- 公开 Endpoint 对象、导入 / 合并操作、公开追加计划或遍历操作。
- 具体数据库、路径、Git、网络、锁、事务、fsync、恢复、分段、index、cache 实现。
- 端 ID 生成、保存、复用、认证、授权、撤销和业务 join。
- 业务 events 清单、批内业务有效性、reducer、批准、生命周期、业务冲突消解。
- 墙上时钟时间戳、exactly-once、共识、自动 GC、认知或任务完成证明。
- Silvermoon 的实现或迁移；未经另行授权的 npm 发布。

## 已确认的设计方向

1. TypeScript，面向 Node.js 与浏览器；内容为应用编码的不透明 Uint8Array。
2. SHA-256 与确定性二进制编码；Envelope 不包含 protocolVersion。
3. channelId 只用于上层路由，不进入 Envelope、规范字节或 hash，
   也不作为外部 hash 上下文。相同节点在不同 channel 可有相同 hash。
4. Channel 是核心公共对象，不再通过 Endpoint 绑定来发送；
   send 参数明确 endpointId，读消息属于 Channel。
5. read 采用 Frontier + 条数限制的分页接口，返回下一次可使用的 Frontier。
6. 保留状态查询和变化订阅，不提供公开导入操作。
7. 每个 channel 的消息有严格递增登记序号，与 hash 并存；
   序号不属于消息内容，不参与 hash，不用时间戳承担排序。
8. 挂接持久化策略；send 成功表示精确节点已登记，不只是生成合法计划。

以下具体类型形状、错误方式和持久化策略签名仍是提案，
不把短问答中的设计方向当作整个 Ideal 的 acceptIdeal。

## 顶层 API 提案

下列声明用于讨论形状，不是已经实现的源文件。
PersistenceStrategy 是后续需要共同确定的扩展点，本版不伪定其方法签名。

```ts
function createChannel(options: {
  persistence: PersistenceStrategy;
}): Channel;

interface Channel {
  send(request: SendRequest): Promise<SendReceipt>;
  read(request: ReadRequest): Promise<ReadPage>;
  getState(): Promise<ChannelState>;
  watch(observer: ChannelObserver): () => void;
}

interface SendRequest {
  readonly endpointId: EndpointId;
  readonly frontier: Frontier;
  readonly content: Uint8Array;
}

interface SendReceipt {
  readonly message: RegisteredMessage;
  readonly currentFrontier: Frontier;
}

interface ReadRequest {
  readonly after: Frontier;
  readonly limit: number;
}

interface ReadPage {
  readonly messages: readonly RegisteredMessage[];
  readonly nextFrontier: Frontier;
  readonly hasMore: boolean;
}

interface ChannelState {
  readonly currentFrontier: Frontier;
}

interface ChannelObserver {
  onChange(state: ChannelState): void;
  onError(error: Error): void;
}
```

createChannel 的策略已绑定到一个目标 channel，库不查找数据库或自动路由。
上层可以用 channelId 获取策略 / Channel，但不需要每次 send 或 read 重复传入。
createChannel 的同步 / 异步初始化、限额配置和错误类型仍待定。
本版 Promise 形状以 reject 表达失败；是否改用 Result 仍待讨论，
但无论选择哪种方式都不能吞错或返回成功形状的兜底值。

### 支撑主操作的数据

```ts
type EndpointId = string & EndpointIdBrand;
type MessageHash = string & MessageHashBrand;
type Frontier = ReadonlyMap<EndpointId, MessageHash>;

interface Envelope {
  readonly endpointId: EndpointId;
  readonly observedFrontier: Frontier;
  readonly content: Uint8Array;
}

interface RegisteredMessage {
  readonly sequence: number;
  readonly hash: MessageHash;
  readonly endpointId: EndpointId;
  readonly content: Uint8Array;
  readonly causalFrontier: Frontier;
}
```

brand 仅为编译期防误用标记，不提供认证或可信输入证明。
ReadonlyMap 与 readonly Uint8Array 也不保证运行时不可变：
内部需保存私有副本，返回值不得暴露可修改内部事实的引用。
Frontier 的具体容器、brand 定义和解析辅助函数是否导出仍待讨论。

sequence 的 number 是暂定表示，实际范围 / 是否采用 bigint 尚待确定。
若采用 number，必须使用正 safe integer，并在耗尽时显式失败，不溢出或复用。

## 四个操作的行为

### send：明确发送方，反馈登记结果

调用者提供 endpointId、真实发送前沿 V 与内容 c。
Channel 读取一致存储视图、验证因果依据、生成规范节点，
再通过持久化策略原子检查并登记。

- V 的本端项必须等于本端当前 tip；缺失表示 bottom。
- 对端位置可落后于最新 tip，但必须合法且不低于本端上一消息已观测的位置。
- 不自动补依赖、替换成最新前沿或修改内容来使发送通过。
- 新节点 hash 为 h；其 causalFrontier 是 V 将本端项更新为 h。
- 成功返回原子登记结果；message.sequence 是该 channel 的登记序号。
- currentFrontier 来自同一提交事务的结果视图，可能含未观察到的其他端消息。
- message.causalFrontier 是消息自身因果历史；不能用 currentFrontier 替代。

反馈只表示已登记，不表示对端已读取、处理、批准或回复。
业务回复仍是对端随后发送的普通消息，本包不提供隐式请求 / 响应语义。

公开结果不区分 committed / already-present，两者都保证目标 channel
存在该精确节点的合法登记。相同节点重投返回原消息和原 sequence，
不新建记录；内部必须先识别合法历史重投，不能仅因本端 tip 已有后继就拒绝重投。
若相同 hash 对应不同字节、或只在全局 blob 中存在而未在目标 channel 登记，
不能当作成功重投。

CAS 冲突必须显式报告；重新读取也不得静默改写原发送依据。
不同端可以并发发送，但策略仍需为成功登记原子分配 channel 全局序号。
首次出现的端可以从 bottom 发送，不需核心 join；
endpointId 的使用权由上层验证，开放维度不等于业务授权。

### read：Frontier 续读，按登记序号分页

每次调用取得固定一致视图 F，返回 Past(F) 中尚未被 Past(after) 覆盖的消息，
按 sequence 升序取最多 limit 条。Past 包含前沿引用节点及其全部因果历史。
after 必须是目标 channel 内合法、闭合且被 F 覆盖的前沿；
未知 hash、缺依赖或非法前沿显式失败，不自动重置为起点。

返回规则：

- messages 包含所有端的未观察消息，包括本端，不按读者身份过滤。
- nextFrontier = after 累计覆盖本页消息的 causalFrontier；
  按同端链祖先关系合并，不能直接用本页最后一条消息的 causalFrontier。
- 不把尚未输出且未在 after 中覆盖的节点塞入 nextFrontier。
- hasMore 仅表示本次一致视图内仍有剩余消息。
- 无剩余时返回空 messages、与 after 相等的 nextFrontier 和 hasMore=false。
- limit 必须是正整数且受资源限额约束，超限显式失败，不悄悄改值。

依赖先登记，故按 sequence 返回时，本页节点的依赖要么已被 after 覆盖，
要么先在本页输出。累计前沿可在下一次调用中继续使用，不需要另造游标。
消息消费成功后，应用再保存 nextFrontier；核心不声称应用已完成业务处理。

分页之间允许新增消息。新登记的 sequence 大于已有序号，
已经登记的消息不重新排序；下一页可包含新消息。
hasMore=false 不是“此 channel 永远没有新消息”，watch 可提示再次读取。
Frontier 表达因果进度，sequence 表达排序位置，两者不互相替代。

### getState：查看当前前沿

返回一致视图中的 currentFrontier，缺失端为 bottom。
调用者可据此决定是否读取，但拿到状态不等于观察或处理了前沿覆盖的内容。
默认不枚举无限个尚未出现的端。

### watch：变化通知与取消

建议回调式订阅，返回取消函数：

```ts
const unwatch = channel.watch({
  onChange(state) { scheduleRead(state); },
  onError(error) { report(error); },
});
unwatch();
```

取消函数幂等；取消后不再启动新回调，已经开始的处理不会自动撤销。
通知可以合并，只提示状态变化 / 继续读取，不是每条消息的交付或确认。
订阅失败通过 onError 显式报告，不能静默假装订阅正常。
是否立即发送初始状态、注册与首次状态如何避免漏通知、
观察者抛错的处理及错误后订阅是否结束，留作下一轮明确规则。

## 持久化策略：扩展点，不是具体存储实现

公共 Channel 编排操作，纯计算内核负责因果与完整性，
策略提供一致快照、读取节点与登记能力。普通调用者不手动执行 planAppend。
策略不能只提供 save(node)，至少要兑现下列语义：

1. 绑定目标 channel，隔离其登记集合；全局 blob 存在不代表该 channel 已登记。
2. 每次读取 / 校验期间提供固定一致快照；允许按需访问，但多次读不能漂移。
3. 在同一原子登记操作中检查本端 expected tip、依赖已登记且不变，
   保存精确节点、更新本端 tip、分配 sequence 并返回一致 currentFrontier。
4. channel 内序号唯一、严格递增，已登记序号不可变，依赖序号小于消息序号。
   不要求无间隙；重投不再分配序号，不因失败而复用已登记序号。
5. 提供按登记序号读取的能力及可取消的变化通知，明确报告 I/O / 订阅错误。

sequence 只属于 channel 内登记元数据，不进入 Envelope 或 hash。
同一节点在不同 channel 中 hash 相同，sequence 可以不同。
不调用 Date.now() 来排序；时钟偏差、回拨和时间戳相同不影响登记顺序。

统一登记序号要求每个 channel 有统一排序点。这不是核心自动提供的分布式共识，
也不能由多个独立副本各自分配序号后声称得到一个全局稳定顺序。
策略的锁、CAS、事务、持久化、恢复、分页索引等实现由存储层负责。
具体方法签名与快照生命周期下一轮再设计，不把旧完整数组快照固定为公共 API。

## 内部正确性边界

### 端链与因果闭包

每个 channel 数学上有可数无限逻辑端，实际前沿是有限支撑映射。
缺失维度为 bottom；规范编码只保存非空维度，不接受 null / undefined 值。
同端版本按链祖先关系比较，不按整数、sequence 或 hash 字符串大小比较。
同端不可比较节点是 fork，明确拒绝，不选择赢家。

节点 n 的本端前驱是 observedFrontier 中的本端项；不额外编码 prev。
闭包提案：对前沿 V 引用的每个节点 q，q.causalFrontier <= V。
例如 B1 观察 A1，后续引用 B1 的消息也必须在 V 中覆盖 A1。
本端上一节点的 causalFrontier 也必须被 V 覆盖，保证观测不倒退。
结构只能证明因果可达，不证明认知或业务处理。

hash 仅在当前 channel 一致视图内解析并检查端归属，不自动查询其他 channel。
Envelope 不含 channel，故核心不能从字节识别错误路由的完整合法历史；
channel 归属、身份认证和授权仍归上层。

### 编码与内容完整性

保留确定性二进制编码方向，具体布局仍为提案：

```text
ASCII("causal-weave") || 0x00
lengthPrefixedUtf8(endpointId)
u32be(frontierEntryCount)
重复 entryCount 次：
  lengthPrefixedUtf8(endpointId)
  rawSha256(32 bytes)
lengthPrefixedBytes(content)
```

length prefix 为 u32be 字节长度；frontier key 按 UTF-8 无符号字节严格递增。
不做 Unicode 归一化；固定前缀是库 hash 域隔离，不是 channel 隔离或协议版本。
hash 不编码自身，sequence 与时间戳也不进入编码。
业务可以把一批有序 events 编码为一个 content，共享因果依据，
核心不要求每个 event 一条消息，也不检查批内业务有效性。

严格拒绝无效 UTF-8、孤立 surrogate、重复 / 乱序 key、错误前缀、
截断、越界长度、尾随字节、超限和 hash 不匹配；不自动修复或截断为成功。
合法字节解码后重编码必须逐字节相同。
未来编码变更必须明确兼容性与内容地址影响，不偷偷添加协议版本字段。

### 错误与资源

输入非法、未知 hash、缺依赖、不闭合、观测倒退、过期本端 tip、
fork、完整性冲突、crypto 不可用、序号耗尽、I/O 和订阅失败均明确报告。
不能将失败变成空分页、成功登记或隐式默认前沿。
错误细节提供必要的端、hash、预期 / 实际值，不泄露 content，不默认打印日志。

编码大小、内容大小、前沿维度、每页条数 / 字节数和校验访问量必须受限；
具体配置和默认值待定。渐进 read 不应要求把整个历史一次装入内存。
不得用宽泛 catch 掩盖程序缺陷，也不承诺 storage failure 下 exactly-once。

## 使用示例

```ts
const channel = createChannel({ persistence: strategyForThisChannel });

const receipt = await channel.send({
  endpointId: myEndpointId,
  frontier: actuallyObservedFrontier,
  content: appEncodedOrderedEvents,
});

let after = actuallyObservedFrontier;
for (;;) {
  const page = await channel.read({ after, limit: 100 });
  await processMessages(page.messages);
  after = page.nextFrontier;
  if (!page.hasMore) break;
}
```

send 的 receipt.currentFrontier 不替代 actuallyObservedFrontier。
应用若只消费了本端新消息，也不能把其他端最新节点伪写进已观察前沿。
订阅用于触发后续读取，业务负责调度与进度保存。

## 契约验证目标（批准后的实现依据）

1. 四个主操作构成普通使用路径，不依赖公开 Endpoint、追加计划或导入接口。
2. 同一 Envelope 在 Node.js / 浏览器字节和 hash 一致；
   key 插入顺序不影响结果，channel 与 sequence 不影响 hash。
3. 空 channel、新端首次发送、多端并发、落后但合法的对端位置都可处理。
4. 本端 tip 过期、观测倒退、缺依赖、不闭合和 fork 明确失败且不改变声明。
5. 本端 CAS 与 sequence 分配原子；不同端写入获得唯一序号，
   所有依赖先于消息，失败不返回登记成功。
6. 精确重投返回原 sequence；tip 有后继也不新建记录；
   其他 channel 的登记或全局 blob 不能当作目标 channel 已登记。
7. read 返回最多 limit 条且 sequence 严格递增；
   nextFrontier 精确累计 after 与已返回消息，不跳过尚未覆盖的内容。
8. 静态历史分多页遍历不漏不重；分页间新增只追加排序，
   空结果、hasMore 和非法 / 未知游标有明确可验证行为。
9. watch 可取消、重复取消安全，取消后不启动新回调，订阅失败显式通知。
10. 外部修改 Map / buffer 不改变内部事实；严格解码和资源限额有反例测试。
11. causalFrontier 与登记 currentFrontier 有并发案例区分，
    任何状态或反馈都不被描述为业务已处理。

## 待解决问题

1. PersistenceStrategy 的最小方法集、固定快照边界、生命周期和变化通知保证。
2. sequence 使用 number、bigint 还是其他表示；合法范围与耗尽策略。
3. Frontier 的容器与解析辅助函数；端 ID 和 hash 表示的精确约束。
4. 是否接受传递闭包规则 q.causalFrontier <= V。
5. Promise reject 或 Result、类型化错误与 CAS 冲突形状。
6. watch 初始通知、无漏订阅边界、观察者异常和订阅错误后的行为。
7. read 条数 / 字节限额、资源 profile、AbortSignal 与关闭资源是否需要接口。
8. Node.js / 浏览器支持矩阵、ESM / CJS、exports、最低 TS 版本、工具链和许可。
9. 精确编码布局及 hash 规则的长期兼容性；不在 Envelope 添加版本字段。
10. npm 发布接口与授权尚未确定，本 idea 不触发 npm 发布。

Implementation、Deployment 与 ledger 保持同步占位。
待用户明确批准精确 Ideal revision 后，再制定实施计划，不自动 acceptIdeal。
