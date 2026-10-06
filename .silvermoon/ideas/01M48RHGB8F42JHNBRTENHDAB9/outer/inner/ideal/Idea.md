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
2. SHA-256 与确定性二进制编码；Message 不包含 protocolVersion。
3. channelId 只用于上层路由，不进入 Message、规范字节或 hash，
   也不作为外部 hash 上下文。相同节点在不同 channel 可有相同 hash。
4. Channel 是核心公共对象，不再通过 Endpoint 绑定来发送；
   send 参数明确 endpointId，读消息属于 Channel。
5. read 采用 Frontier + 条数限制的分页接口，返回下一次可使用的 Frontier。
6. 保留状态查询和变化订阅，不提供公开导入操作。
7. 每个 channel 的消息有严格递增登记序号，与 hash 并存；
   序号不属于消息内容，不参与 hash，不用时间戳承担排序。
8. 挂接持久化策略；send 成功表示精确节点已登记，不只是生成合法计划。
9. 消息字段统一为 Message，发送与编码直接使用它，RegisteredMessage 扩展它，
   不再分别定义 Envelope、SendRequest 或使用 observedFrontier 这一字段名。
10. Message 包含 contentType，提示接收方内容格式；
    核心保存但不做业务解码，contentType 随消息参与 hash。
11. RegisteredMessage 不保存可推导的 causalFrontier 字段，
    仅在 Message 上增加 hash 和 sequence；包含自身的因果前沿由内部计算。
12. Strategy 提供底层存储原语，不理解消息的因果规则；所有合法性检查由 Channel 执行。
13. 不要求 acquireLock、snapshot 或 withRead。
    append 使用 channel 最新已登记序号 expectedSequence 作原子乐观条件；
    空 channel 的最新序号为 0，Frontier 不是存储 revision。
14. 可预期失败采用每个 API 自己的 Result<OkType, ErrorType>，
    不把所有方法的错误合并为一个无差别的大联合，也不以 Promise reject 表达正常失败。

以下具体类型形状、错误方式和持久化策略签名仍是提案，
不把短问答中的设计方向当作整个 Ideal 的 acceptIdeal。

## 顶层 API 提案

下列声明用于讨论形状，不是已经实现的源文件。
PersistenceStrategy 的底层接口形状见后文，具体签名仍是讨论提案。

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function createChannel(options: {
  persistence: PersistenceStrategy;
}): Result<Channel, CreateChannelError>;

interface Channel {
  send(message: Message): Promise<Result<SendReceipt, SendError>>;
  read(request: ReadRequest): Promise<Result<ReadPage, ReadError>>;
  getState(): Promise<Result<ChannelState, GetStateError>>;
  watch(observer: ChannelObserver): Result<Unwatch, WatchStartError>;
}

type Unwatch = () => Promise<Result<void, WatchCancelError>>;

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
  onError(error: WatchRuntimeError): void;
}
```

createChannel 的策略已绑定到一个目标 channel，库不查找数据库或自动路由。
上层可以用 channelId 获取策略 / Channel，但不需要每次 send 或 read 重复传入。
本版 createChannel 只进行同步配置检查，不访问存储。
watch 同步注册的签名仍为提案；若需要异步注册，应改为 Promise<Result<...>>，
不在底层尚未注册时提前声称成功。限额配置和初始化细节仍待定。
错误联合和逐项含义见下文；程序缺陷仍可 throw / reject，不广泛 catch 为正常失败。

### 支撑主操作的数据

```ts
type EndpointId = string & EndpointIdBrand;
type MessageHash = string & MessageHashBrand;
type Frontier = ReadonlyMap<EndpointId, MessageHash>;

interface Message {
  readonly endpointId: EndpointId;
  readonly frontier: Frontier;
  readonly contentType: string;
  readonly content: Uint8Array;
}

interface RegisteredMessage extends Message {
  readonly sequence: number;
  readonly hash: MessageHash;
}
```

Message 是发送、规范编码和内容寻址共同使用的数据，不再套一层 envelope 属性。
RegisteredMessage 保留全部 Message 字段，只增加内容地址和登记序号。
frontier 始终是发送前的因果依据；包含自身的前沿可以从 frontier、
endpointId 和 hash 推导，不重复保存或作为公开字段返回。
内部记该派生值为 C(m) = m.frontier 将 m.endpointId 项更新为 m.hash，
计算时生成新映射，不修改原 frontier。
currentFrontier 则是 channel 的整体登记视图，不能替代发送依据或 C(m)。

contentType 是应用提供给接收方的格式提示，例如 application/json。
核心不根据它解析 content，也不检查字节是否符合所声明的格式。
相同字节但不同 contentType 声明是不同 Message，必须纳入完整性校验，
不能在不改变 hash 的情况下替换格式提示。
是否严格采用 MIME media type、允许何种字符 / 空值，以及长度上限仍待讨论；
不自动改大小写、trim 或归一化来改变调用者的原始声明。

brand 仅为编译期防误用标记，不提供认证或可信输入证明。
ReadonlyMap 与 readonly Uint8Array 也不保证运行时不可变：
内部需保存私有副本，返回值不得暴露可修改内部事实的引用。
Frontier 的具体容器、brand 定义和解析辅助函数是否导出仍待讨论。

sequence 的 number 是暂定表示，实际范围 / 是否采用 bigint 尚待确定。
若采用 number，必须使用正 safe integer，并在耗尽时显式失败，不溢出或复用。

## 四个操作的行为

### send：明确发送方，反馈登记结果

调用者提供 Message：endpointId、真实发送前沿 frontier = V、contentType 与内容 c。
Channel 先读取最新已登记序号 S，再读取截至 S 的历史，
验证因果依据、生成规范节点，然后调用 append(expectedSequence: S)。
策略只原子比较存储序号并登记，不执行因果检查。

- V 的本端项必须等于本端当前 tip；缺失表示 bottom。
- 对端位置可落后于最新 tip，但必须合法且不低于本端上一消息已观测的位置。
- 不自动补依赖、替换成最新前沿或修改内容来使发送通过。
- 新节点 hash 为 h；包含自身的前沿 C(message) 是 V 将本端项更新为 h，
  由内部推导，不增加公开字段。
- 成功返回原子登记结果；message.sequence 是该 channel 的登记序号。
- currentFrontier 由 Channel 从截至成功登记序号的固定历史前缀计算，
  不要求策略理解或返回 Frontier；可能含未观察到的其他端消息。
  精确历史重投时使用本次读取边界 S 的前沿，不伪称恢复了原登记时的最新状态。
- C(message) 覆盖消息自身因果历史；不能用 currentFrontier 替代。

反馈只表示已登记，不表示对端已读取、处理、批准或回复。
业务回复仍是对端随后发送的普通消息，本包不提供隐式请求 / 响应语义。

公开结果不区分 committed / already-present，两者都保证目标 channel
存在该精确节点的合法登记。相同节点重投返回原消息和原 sequence，
不新建记录；内部必须先识别合法历史重投，不能仅因本端 tip 已有后继就拒绝重投。
若相同 hash 对应不同字节、或只在全局 blob 中存在而未在目标 channel 登记，
不能当作成功重投。

策略显式返回存储 CAS 冲突，Channel 保持原 Message 不变，重新读取并完整核验后重试。
其他端追加也会推进 channel 序号、造成存储冲突，但本身不是消息的因果错误。
若本端已前进且不是精确重投，则原消息不能继续追加，Channel 显式报告本端 tip 过期。
重试次数 / 取消规则待定，不允许无限隐藏重试或把耗尽当成成功。
不同端可以并发发送，但策略仍需为成功登记原子分配 channel 全局序号。
首次出现的端可以从 bottom 发送，不需核心 join；
endpointId 的使用权由上层验证，开放维度不等于业务授权。

### read：Frontier 续读，按登记序号分页

每次调用先读取最新已登记序号 S，Channel 以不可变历史前缀 sequence <= S
计算一致视图 F，返回 Past(F) 中尚未被 Past(after) 覆盖的消息，
按 sequence 升序取最多 limit 条。Past 包含前沿引用节点及其全部因果历史。
after 必须是目标 channel 内合法、闭合且被 F 覆盖的前沿；
未知 hash、缺依赖或非法前沿显式失败，不自动重置为起点。

返回规则：

- messages 包含所有端的未观察消息，包括本端，不按读者身份过滤。
- nextFrontier = after 累计覆盖本页消息的 C(message)；
  按同端链祖先关系合并，不能直接用本页最后一条消息的 C(message)。
  read 内部计算并返回累计结果，调用者无需逐条推导。
- 不把尚未输出且未在 after 中覆盖的节点塞入 nextFrontier。
- hasMore 仅表示本次一致视图内仍有剩余消息。
- 无剩余时返回空 messages、与 after 相等的 nextFrontier 和 hasMore=false。
- limit 必须是正整数且受资源限额约束，超限显式失败，不悄悄改值。

底层 scan 只按序号扫描，不接收 Frontier，也不判断消息是否已观察。
Channel 验证 after、过滤已覆盖消息、累计 nextFrontier，并判断 hasMore。
一次底层 scan 可能被过滤为空，不能据此当作读取结束；
需要继续扫描直到达到返回上限、确认还有剩余，或到达本次边界 S。
具体边界参数形状见后文提案，写入 CAS 本身不提供读取分页的一致性。

依赖先登记，故按 sequence 返回时，本页节点的依赖要么已被 after 覆盖，
要么先在本页输出。累计前沿可在下一次调用中继续使用，不需要另造游标。
消息消费成功后，应用再保存 nextFrontier；核心不声称应用已完成业务处理。

分页之间允许新增消息。新登记的 sequence 大于已有序号，
已经登记的消息不重新排序；下一页可包含新消息。
hasMore=false 不是“此 channel 永远没有新消息”，watch 可提示再次读取。
Frontier 表达因果进度，sequence 表达排序位置，两者不互相替代。

### getState：查看当前前沿

先读取最新已登记序号 S，由 Channel 基于截至 S 的不可变历史
计算 currentFrontier，缺失端为 bottom。策略不提供业务 getFrontier。
调用者可据此决定是否读取，但拿到状态不等于观察或处理了前沿覆盖的内容。
默认不枚举无限个尚未出现的端。

### watch：变化通知与取消

建议回调式订阅，返回取消函数：

```ts
const watched = channel.watch({
  onChange(state) { scheduleRead(state); },
  onError(error) { report(error); },
});
if (!watched.ok) {
  report(watched.error);
  return;
}
const cancelled = await watched.value();
if (!cancelled.ok) report(cancelled.error);
```

调用取消函数立即停止向应用启动新回调，已经开始的处理不会自动撤销；
返回 Promise<Result<void, WatchCancelError>> 等待底层资源释放结果。
成功后重复取消返回成功；释放失败显式报告，允许再次尝试释放，不重新启用回调。
通知可以合并，只提示状态变化 / 继续读取，不是每条消息的交付或确认。
订阅失败通过 onError 显式报告，不能静默假装订阅正常。
是否立即发送初始状态、注册与首次状态如何避免漏通知、
观察者抛错的处理及错误后订阅是否结束，留作下一轮明确规则。

## 持久化策略：扩展点，不是具体存储实现

### 底层接口形状提案

策略由调用方提供，只负责登记记录的持久化、查询、序号 CAS 与存储变化通知。
Channel 负责 hash、端 tip、祖先关系、闭包、观测单调性、fork、幂等判断和分页前沿。
不向策略传入 expectedTip、Frontier 或“消息是否合法”的检查回调，
也不要求策略创建 snapshot / withRead 作用域或暴露悲观锁。

```ts
interface PersistenceStrategy {
  getLatestSequence(): Promise<Result<number, PersistenceReadError>>;

  get(hash: MessageHash): Promise<Result<RegisteredMessage | undefined, PersistenceGetError>>;

  scan(request: {
    afterSequence: number;
    throughSequence: number;
    limit: number;
  }): Promise<Result<readonly RegisteredMessage[], PersistenceScanError>>;

  append(request: {
    expectedSequence: number;
    message: Message;
    hash: MessageHash;
  }): Promise<Result<RegisteredMessage, PersistenceAppendError>>;

  watch(observer: PersistenceObserver): Result<Unwatch, PersistenceWatchStartError>;
}

interface PersistenceObserver {
  onChange(): void;
  onError(error: PersistenceWatchRuntimeError): void;
}
```

number 仍是暂定序号类型，与 RegisteredMessage.sequence 一致。
scan 返回 afterSequence < sequence <= throughSequence 的记录，按序号升序取最多 limit 条。
afterSequence=0 从头开始；throughSequence 是 Channel 先取得的最新已登记序号。
它只是数值范围查询，不携带因果或已观察判断。
此范围参数用于表达分页读取边界，具体签名仍可继续讨论。

get 只查询目标 channel 的登记集合，缺失为 ok(undefined)，I/O 失败返回类型化 error。
若返回记录的 sequence > 本次边界 S，Channel 不把它纳入截至 S 的视图。
Channel 可用 get 逐步读取前沿引用节点、端内前驱及传递依赖；
需要从 scan 重建各端 tip / 当前前沿。缓存与索引优化不改变这些校验职责。

### append 的乐观条件不是业务检查

expectedSequence 是 channel 的最新已登记序号，不是 Message.frontier，
也不是 frontier 引用节点序号的最大值。调用者可以真实地没有观察到最新消息。
策略在一个原子存储操作中：

1. 比较最新已登记序号与 expectedSequence。
2. 不相等则返回 SEQUENCE_CONFLICT，携带 actualSequence，不写入、不分配已登记记录。
3. 相等则原样保存 message 与 hash，分配大于现有最新序号的新序号，
   原子公开登记记录及新的最新序号，返回 RegisteredMessage。

策略不验证 hash、依赖或本端 tip，也不计算前沿；裸登记只附带通用存储 CAS。
Channel 的 send 流程是：

```text
先读取最新序号 S
→ 读取截至 S 的记录并核验，识别精确历史重投
→ 重投返回原登记；否则验证原 Message
→ append(expectedSequence: S)
→ 存储冲突则保持原 Message，重新观察、核验后重试
```

相同 channel 的多个 Channel 实例 / 进程共用同一个存储序号 CAS。
即使两者检查到相同本端 tip，也只有一个能按相同 S 登记；
另一个重新核验，不能自动产生端内分叉。
本端 tip 与依赖检查属于 Channel，不属于策略；
全局序号 CAS 将已完成的这些检查绑定到实际登记的存储前态。

### 只追加与读取边界

用最新序号充当 revision 的前提：

- 所有登记都通过同一原子 append，已登记记录及序号不可修改、删除或复用。
- getLatestSequence 返回已提交记录的高水位，不是预分配或尚未落盘的序号。
- 一旦高水位 S 可见，所有截至 S 的已登记记录均可读取；
  不能以后再公开 sequence <= S 的新记录。
- scan 范围完整且有序，get 可读已登记内容；不能使用无明确一致性保证的滞后副本。

这些是存储语义，不是业务校验。由此截至 S 的历史前缀不变，
后续并发写入只在 S 之后；Channel 可自己形成一致读取边界，不要求快照对象。
遇到本次边界外的新引用 / 不稳定输入时不能按混合视图宣告校验成功，
错误分类与重新观察规则需在实现契约中明确。

若未来允许删除、改写或其他不推进登记序号的状态变化，
最新序号就不足以充当 revision，需要另设版本机制，不能沿用本承诺。
无间隙不是必要条件，但不能迟到填补旧高水位以内的空隙。
读取分页的一致性依靠不可变前缀与明确边界，不依靠 append CAS 自动解决。

### watch 与职责归属

策略通知登记变化，不返回 Frontier；Channel 在通知后读取边界、计算状态，
再调用公开 onChange。通知可以合并，需明确报告失败并提供幂等取消。
初始状态和订阅注册如何避免漏变化仍待讨论。

sequence 只属于 channel 内登记元数据，不进入 Message 的规范编码或 hash。
同一节点在不同 channel 中 hash 相同，sequence 可以不同。
不调用 Date.now() 来排序；时钟偏差、回拨和时间戳相同不影响登记顺序。

统一登记序号要求每个 channel 有统一排序点。这不是核心自动提供的分布式共识，
也不能由多个独立副本各自分配序号后声称得到一个全局稳定顺序。
存储 CAS、内部事务、持久化、恢复和分页索引的实现归策略；
策略可自行选择内部机制，但公共接口不要求 acquireLock。
消息依赖先于消息的登记顺序由 Channel 校验与条件登记共同保证，
不能声称策略裸 append 会防止绕过 Channel 的非法写入。
不信任可绕过本包写入者；发现坏历史时核心明确报错，不为其选赢家。

## 内部正确性边界

### 端链与因果闭包

每个 channel 数学上有可数无限逻辑端，实际前沿是有限支撑映射。
缺失维度为 bottom；规范编码只保存非空维度，不接受 null / undefined 值。
同端版本按链祖先关系比较，不按整数、sequence 或 hash 字符串大小比较。
同端不可比较节点是 fork，明确拒绝，不选择赢家。

节点 n 的本端前驱是 frontier 中的本端项；不额外编码 prev。
闭包提案：对前沿 V 引用的每个节点 q，C(q) <= V。
例如 B1 观察 A1，后续引用 B1 的消息也必须在 V 中覆盖 A1。
本端上一节点的 C(q) 也必须被 V 覆盖，保证观测不倒退。
结构只能证明因果可达，不证明认知或业务处理。

hash 仅在当前 channel 一致视图内解析并检查端归属，不自动查询其他 channel。
Message 不含 channel，故核心不能从字节识别错误路由的完整合法历史；
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
lengthPrefixedUtf8(contentType)
lengthPrefixedBytes(content)
```

length prefix 为 u32be 字节长度；frontier key 按 UTF-8 无符号字节严格递增。
不做 Unicode 归一化；固定前缀是库 hash 域隔离，不是 channel 隔离或协议版本。
hash 不编码自身，sequence 与时间戳也不进入编码。
只有 Message 的字段参与规范编码；RegisteredMessage 中额外的字段不参与 hash。
contentType 按声明的 UTF-8 字节编码，与 frontier 和 content 一起受到 hash 保护。
业务可以把一批有序 events 编码为一个 content，共享因果依据，
核心不要求每个 event 一条消息，也不检查批内业务有效性。

严格拒绝无效 UTF-8、孤立 surrogate、重复 / 乱序 key、错误前缀、
截断、越界长度、尾随字节、超限和 hash 不匹配；不自动修复或截断为成功。
合法字节解码后重编码必须逐字节相同。
未来编码变更必须明确兼容性与内容地址影响，不偷偷添加协议版本字段。

### 错误与资源

#### 错误结构与各 API 的错误集合

错误按 code 判别，details 与 code 一一对应，不使用 any 或任意字典。
本版用 ErrorCatalog 集中表达各错误的必要数据；ErrorOf 展开为判别联合。
以下为 API 提案，不将策略提供的错误文本或 cause 当作安全可直接展示的内容。

```ts
interface ErrorCatalog {
  INVALID_OPTIONS: { field: string; reason: string };
  INVALID_MESSAGE: { field: string; reason: string };
  INVALID_READ_REQUEST: { field: string; reason: string };
  INVALID_FRONTIER: { field: string; reason: string };
  UNKNOWN_HASH: { endpointId: EndpointId; hash: MessageHash };
  FRONTIER_BEYOND_BOUNDARY: { hash: MessageHash; sequence: number; boundary: number };
  ENDPOINT_MISMATCH: { hash: MessageHash; expected: EndpointId; actual: EndpointId };
  FRONTIER_NOT_CLOSED: {
    endpointId: EndpointId;
    required: MessageHash;
    declared: MessageHash | null;
  };
  STALE_ENDPOINT_TIP: {
    endpointId: EndpointId;
    declaredTip: MessageHash | null;
    actualTip: MessageHash | null;
  };
  OBSERVATION_REGRESSION: {
    endpointId: EndpointId;
    required: MessageHash;
    declared: MessageHash | null;
  };
  INVALID_ENCODING: { hash: MessageHash; field: string; reason: string };
  HASH_MISMATCH: { expected: MessageHash; computed: MessageHash };
  HASH_COLLISION: { hash: MessageHash };
  MISSING_DEPENDENCIES: { referencingHash: MessageHash; missing: readonly MessageHash[] };
  FORK: {
    endpointId: EndpointId;
    predecessor: MessageHash | null;
    successors: readonly [MessageHash, MessageHash];
  };
  CAUSAL_CYCLE: { hashes: readonly MessageHash[] };
  INVALID_REGISTRATION: { sequence: number; hash: MessageHash; reason: string };
  STRATEGY_CONTRACT_VIOLATION: { operation: string; reason: string };
  LIMIT_EXCEEDED: { limit: string; maximum: number; actual: number };
  CRYPTO_UNAVAILABLE: { reason: string };
  CRYPTO_FAILURE: { cause: unknown };
  STORAGE_UNAVAILABLE: { operation: string; cause: unknown };
  STORAGE_READ_FAILED: { operation: string; cause: unknown };
  STORAGE_WRITE_FAILED: { cause: unknown };
  INVALID_STORAGE_REQUEST: { field: string; reason: string };
  SEQUENCE_CONFLICT: { expectedSequence: number; actualSequence: number };
  SEQUENCE_EXHAUSTED: { latestSequence: number };
  RETRY_EXHAUSTED: { attempts: number; expectedSequence: number; actualSequence: number };
  APPEND_OUTCOME_UNKNOWN: { hash: MessageHash; cause: unknown };
  SEND_RECEIPT_FAILED: { message: RegisteredMessage; cause: GetStateError };
  INVALID_OBSERVER: { field: string; reason: string };
  WATCH_START_FAILED: { cause: unknown };
  WATCH_FAILED: { cause: unknown };
  WATCH_CANCEL_FAILED: { cause: unknown };
}

type ErrorOf<K extends keyof ErrorCatalog> = {
  [C in K]: {
    readonly code: C;
    readonly message: string;
    readonly details: Readonly<ErrorCatalog[C]>;
  }
}[K];

type CreateChannelError = ErrorOf<"INVALID_OPTIONS">;

type FrontierError = ErrorOf<
  "INVALID_FRONTIER" | "UNKNOWN_HASH" | "FRONTIER_BEYOND_BOUNDARY" |
  "ENDPOINT_MISMATCH" | "FRONTIER_NOT_CLOSED"
>;
type HistoryError = ErrorOf<
  "INVALID_ENCODING" | "HASH_MISMATCH" | "HASH_COLLISION" |
  "MISSING_DEPENDENCIES" | "FORK" | "CAUSAL_CYCLE" |
  "INVALID_REGISTRATION" | "STRATEGY_CONTRACT_VIOLATION"
>;
type ResourceError = ErrorOf<"LIMIT_EXCEEDED">;
type CryptoError = ErrorOf<"CRYPTO_UNAVAILABLE" | "CRYPTO_FAILURE">;
type PersistenceReadError = ErrorOf<"STORAGE_UNAVAILABLE" | "STORAGE_READ_FAILED">;
type PersistenceGetError = PersistenceReadError | ErrorOf<"INVALID_STORAGE_REQUEST">;
type PersistenceScanError = PersistenceReadError | ErrorOf<"INVALID_STORAGE_REQUEST">;
type PersistenceAppendError = ErrorOf<
  "INVALID_STORAGE_REQUEST" | "SEQUENCE_CONFLICT" | "SEQUENCE_EXHAUSTED" |
  "STORAGE_UNAVAILABLE" | "STORAGE_WRITE_FAILED" | "APPEND_OUTCOME_UNKNOWN"
>;
type PersistenceWatchStartError = ErrorOf<
  "INVALID_OBSERVER" | "STORAGE_UNAVAILABLE" | "WATCH_START_FAILED"
>;
type PersistenceWatchRuntimeError = ErrorOf<"STORAGE_UNAVAILABLE" | "WATCH_FAILED">;
type WatchCancelError = ErrorOf<"WATCH_CANCEL_FAILED">;

type GetStateError = HistoryError | ResourceError | CryptoError | PersistenceReadError;
type ReadError = FrontierError | GetStateError | ErrorOf<"INVALID_READ_REQUEST">;
type SendError = FrontierError | GetStateError |
  ErrorOf<
    "INVALID_MESSAGE" | "STALE_ENDPOINT_TIP" | "OBSERVATION_REGRESSION" |
    "RETRY_EXHAUSTED" | "SEQUENCE_EXHAUSTED" | "STORAGE_WRITE_FAILED" |
    "APPEND_OUTCOME_UNKNOWN" | "SEND_RECEIPT_FAILED"
  >;
type WatchStartError = PersistenceWatchStartError;
type WatchRuntimeError = PersistenceWatchRuntimeError | GetStateError;
```

getState / read 也可能核验已存节点 hash，故包含 CryptoError，
不是仅 send 可能使用 hash 计算。
Channel 自己构造策略请求；策略若因此返回 INVALID_STORAGE_REQUEST，
表明两侧接口契约不一致，转换为 STRATEGY_CONTRACT_VIOLATION，不能当成业务输入错误。
SEQUENCE_CONFLICT 由 send 内部处理，重试耗尽才返回 RETRY_EXHAUSTED；
若重新检查发现本端已前进，返回 STALE_ENDPOINT_TIP 而非继续盲目重试。

#### 每种错误的触发情况

| code | 情况与必要解释 |
| --- | --- |
| INVALID_OPTIONS | createChannel 配置缺失、限额非法或策略方法不可调用；同步返回，尚未访问存储。 |
| INVALID_MESSAGE | endpointId、contentType、content 等字段不符合已确定的结构 / 字符要求；不校验业务内容是否符合 contentType。 |
| INVALID_READ_REQUEST | read.limit 不是正整数或请求结构错误；超过配置上限则用 LIMIT_EXCEEDED。 |
| INVALID_FRONTIER | 映射结构、key 或 hash 形状非法，重复维度、显式 null / undefined 等；不得自动规范化为合法前沿。 |
| UNKNOWN_HASH | 调用方前沿直接引用的 hash 不在目标 channel 登记集合中；不当作 bottom，也不查其他 channel。 |
| FRONTIER_BEYOND_BOUNDARY | 引用记录已存在但 sequence 大于本次固定读取边界 S；不能混入旧视图。send 可重新观察后核验，耗尽或不能继续时明确返回，read 不偷偷移动边界。 |
| ENDPOINT_MISMATCH | 调用方某维度引用的节点属于另一 endpoint；details 给出引用 hash 与 expected / actual。 |
| FRONTIER_NOT_CLOSED | 输入前沿遗漏被引用节点的传递因果依据，或给出了不足以覆盖它的位置；不补 refs。 |
| STALE_ENDPOINT_TIP | 排除精确重投后，消息声明的本端位置不是截至 S 的本端 tip；本端竞争通常产生此错误。 |
| OBSERVATION_REGRESSION | 相比本端上一节点，声明的其他端位置后退或遗漏；用链祖先关系判断，不用 sequence 大小替代。 |
| INVALID_ENCODING | 已存数据无法严格规范编码 / 解码，例如无效字符串、重复维度或截断规范字节；指历史损坏，而非新发送字段错误。 |
| HASH_MISMATCH | 已存消息按规范计算出的 hash 不等于存储声明的 hash；不得继续当作合法依赖。 |
| HASH_COLLISION | 发现相同 hash 对应不同规范消息字节；只报告完整性冲突，不选一份为真。 |
| MISSING_DEPENDENCIES | 已存节点的历史依赖缺失；区别于调用方直接引用未知 hash，意味着已有历史不完整。 |
| FORK | 已有历史中同端同一前驱有两个不同后继；提供前驱与两个后继证据，不选赢家。 |
| CAUSAL_CYCLE | 已存依赖图形成循环，不能形成合法因果历史；提供相关 hash，拒绝输出合法状态。 |
| INVALID_REGISTRATION | 登记序号非法、重复、依赖序号不小于消息序号，或记录关系不满足只追加登记规则；给出记录及原因。 |
| STRATEGY_CONTRACT_VIOLATION | 可观察到策略违约，例如 scan 乱序 / 越界、get 返回另一 hash、已读记录发生变化、高水位回退或成功 append 返回不同消息；不伪装为普通空数据。 |
| LIMIT_EXCEEDED | 内容、编码、前沿维度、页大小或历史访问量超过配置限制；给出限额名称、maximum / actual，不截断为成功。 |
| CRYPTO_UNAVAILABLE | 运行环境没有所需 SHA-256 能力；不能降级为另一算法或占位 hash。 |
| CRYPTO_FAILURE | 已识别的 hash provider 执行失败；保留 cause，不把未知程序错误一律归入此项。 |
| STORAGE_UNAVAILABLE | 对应操作无法接入存储。用于 append 时必须确定尚未写入；若可能已写入，必须改报 APPEND_OUTCOME_UNKNOWN。 |
| STORAGE_READ_FAILED | getLatestSequence / get / scan 的读取失败；不返回 0、undefined 或空列表伪装正常结果。 |
| STORAGE_WRITE_FAILED | append 确定未登记成功的写入失败，例如原子事务确定回滚；不知道是否回滚不能用此项。 |
| INVALID_STORAGE_REQUEST | 直接调用策略时的 hash / expectedSequence / scan 数值范围 / limit 等基础参数非法；策略只检查存储参数，不检查因果或业务格式。 |
| SEQUENCE_CONFLICT | append 原子比较发现最新序号不是 expectedSequence；带两值，保证本次未写入。 |
| SEQUENCE_EXHAUSTED | 无法分配合法且更大的登记序号；本次不写入，不回绕或复用序号。 |
| RETRY_EXHAUSTED | Channel 因存储序号竞争或边界变化重试至配置上限；没有得到成功或不确定的 append，返回次数与最近序号，不能无限隐藏重试。 |
| APPEND_OUTCOME_UNKNOWN | 写入可能已成功，但响应丢失或持久化结果无法确认；带原 hash。不得说“未发送”，不得更换消息内容 / 前沿盲目重发。 |
| SEND_RECEIPT_FAILED | 已确认目标消息登记，但计算 currentFrontier 等反馈步骤失败；带已登记 RegisteredMessage 和 GetStateError，不能当成未写入。 |
| INVALID_OBSERVER | watch 缺少可调用的 onChange / onError 等结构错误；不是用户回调执行时抛出的程序异常。 |
| WATCH_START_FAILED | 注册订阅失败，尚未取得可用订阅；策略应清理部分建立的资源，无法清理时在失败详情说明，不能声称注册成功。 |
| WATCH_FAILED | 已注册订阅运行期间的已识别通知机制失败；通过 onError 报告，不伪造正常变化。订阅是否终止待定。 |
| WATCH_CANCEL_FAILED | 停止回调后，底层释放订阅资源失败；取消结果显式报告，可再尝试释放，不能恢复应用回调。 |

存储完整性表不能替代一致性保证：核心只能诊断它实际观察到的违约，
不能证明策略没有漏报一条尚不可见的记录；策略仍必须兑现只追加 / 高水位语义。
历史内发现的端归属 / 闭包 / 观测倒退错误属于坏历史，
由 INVALID_ENCODING 或 INVALID_REGISTRATION 携带原因与记录标识，
不误报成此次发送者修改其请求即可修复的问题。

#### 正常结果不是错误

- get 未找到：ok(undefined)；Channel 据上下文区分 UNKNOWN_HASH / MISSING_DEPENDENCIES。
- scan / read 合法范围内无消息：ok(空结果)，不当作存储故障。
- 精确历史重投：ok(原登记记录)，无公开 already-present 分支。
- 多个端的合法并发：正常历史，不是 FORK。
- 幂等取消已成功结束的订阅：ok(undefined)。

#### 写入结果与异常边界

send 的登记结果分三类：

1. 尚未写入：输入 / 校验失败、确定未写入的存储错误、重试耗尽。
2. 不确定：APPEND_OUTCOME_UNKNOWN；先按原 hash 查询并核验。
   未查到不能在不可靠读取上证明未写入，应遵守策略一致性和恢复约定。
3. 已确认登记：正常 SendReceipt，或 SEND_RECEIPT_FAILED 中的 message。
   后者可重查状态 / 使用原消息精确重投，不改写前沿生成新消息。

append 收到不确定结果后，Channel 不能把它当作普通 SEQUENCE_CONFLICT 自动重试；
应先确认原登记，不能确认则将不确定结果交给调用者。
若策略成功返回后出现可观察违约、记录本身都不能可信确认，
按不确定登记结果报告，并保留违约原因，而不是暗示没有写入。
若尚未写入且已存历史损坏，HistoryError 表示无法继续安全操作。

Strategy 可预期的操作失败也必须返回 Result；未约定的 throw / reject、
用户回调自身异常与包内部程序缺陷仍属于异常边界，
不能广泛 catch 后变成成功、普通用户错误或未写入证明。
回调异常的调度 / 上报机制仍需定稿，不能递归调用 onError 或吞掉异常。

不能将失败变成空分页、成功登记或隐式默认前沿。
错误细节提供必要的端、hash、预期 / 实际值，不泄露 content，不默认打印日志。

编码大小、内容大小、前沿维度、每页条数 / 字节数和校验访问量必须受限；
具体配置和默认值待定。渐进 read 不应要求把整个历史一次装入内存。
不得用宽泛 catch 掩盖程序缺陷，也不承诺 storage failure 下 exactly-once。

## 使用示例

```ts
const created = createChannel({ persistence: strategyForThisChannel });
if (!created.ok) {
  report(created.error);
  return;
}
const channel = created.value;

const receipt = await channel.send({
  endpointId: myEndpointId,
  frontier: actuallyObservedFrontier,
  contentType: "application/json",
  content: appEncodedOrderedEvents,
});
if (!receipt.ok) {
  report(receipt.error);
  return;
}

let after = actuallyObservedFrontier;
for (;;) {
  const result = await channel.read({ after, limit: 100 });
  if (!result.ok) {
    report(result.error);
    return;
  }
  const page = result.value;
  await processMessages(page.messages);
  after = page.nextFrontier;
  if (!page.hasMore) break;
}
```

send 成功值的 receipt.value.currentFrontier 不替代 actuallyObservedFrontier。
应用若只消费了本端新消息，也不能把其他端最新节点伪写进已观察前沿。
订阅用于触发后续读取，业务负责调度与进度保存。

## 契约验证目标（批准后的实现依据）

1. 四个主操作构成普通使用路径，不依赖公开 Endpoint、追加计划或导入接口。
2. 同一 Message 在 Node.js / 浏览器字节和 hash 一致；
   key 插入顺序不影响结果，channel 与 sequence 不影响 hash。
   只改变 contentType 的向量必须产生不同 hash，格式提示不能被未经核验地替换。
3. 空 channel、新端首次发送、多端并发、落后但合法的对端位置都可处理。
4. 本端 tip 过期、观测倒退、缺依赖、不闭合和 fork 明确失败且不改变声明。
5. Channel 检查本端 tip 与依赖，策略只做 expectedSequence 的原子 CAS 和序号分配；
   多实例同端竞争不产生分叉，其他端推进引发存储冲突后保留原消息重试。
   所有依赖先于消息，失败不返回登记成功。
6. 精确重投返回原 sequence；tip 有后继也不新建记录；
   其他 channel 的登记或全局 blob 不能当作目标 channel 已登记。
7. read 返回最多 limit 条且 sequence 严格递增；
   nextFrontier 精确累计 after 与已返回消息，不跳过尚未覆盖的内容。
8. 静态历史分多页遍历不漏不重；分页间新增只追加排序，
   空结果、hasMore 和非法 / 未知游标有明确可验证行为。
9. watch 可取消、重复取消安全，取消后不启动新回调，订阅失败显式通知。
10. 外部修改 Map / buffer 不改变内部事实；严格解码和资源限额有反例测试。
11. RegisteredMessage 仅扩展 hash 和 sequence，不返回冗余 causalFrontier；
    内部派生的 C(message) 与登记 currentFrontier 有并发案例区分，
    任何状态或反馈都不被描述为业务已处理。
12. 最新序号先于校验读取；0 表示空 channel。以旧序号 append 原子失败且不写入。
    分页固定 throughSequence 边界，过程中新增不会混入本页；
    策略不需要理解 Frontier、实现快照对象或提供悲观锁。
13. 各 API 的 Result 错误联合可按 code 穷尽处理；存储故障不变成空结果，
    输入错误与坏历史区分，冲突不当作 I/O 失败。
    用响应丢失、事务回滚、append 成功后状态读取失败分别验证
    APPEND_OUTCOME_UNKNOWN、STORAGE_WRITE_FAILED、SEND_RECEIPT_FAILED，
    并验证取消释放错误不重新启动回调。

## 待解决问题

1. PersistenceStrategy 具体签名、scan 范围 / 完整性规则与变化通知保证；
   不再要求 snapshot、withRead 或 acquireLock。
2. sequence 使用 number、bigint 还是其他表示；合法范围与耗尽策略。
3. Frontier 的容器与解析辅助函数；端 ID 和 hash 表示的精确约束。
4. 是否接受传递闭包规则 C(q) <= V。
5. 各错误细节字段的最终形状、存储 CAS 的重试上限 / 取消、
   不确定登记后的恢复规则；已采用逐 API Result，不再待选正常失败用 reject。
6. watch 初始通知、无漏订阅边界、观察者异常和订阅错误后的行为。
7. read 条数 / 字节限额、资源 profile、AbortSignal 与关闭资源是否需要接口。
8. Node.js / 浏览器支持矩阵、ESM / CJS、exports、最低 TS 版本、工具链和许可。
9. 精确编码布局及 hash 规则的长期兼容性；不在 Message 添加版本字段。
10. npm 发布接口与授权尚未确定，本 idea 不触发 npm 发布。
11. contentType 是否严格遵守 MIME media type，字符 / 空值 / 长度约束是什么；
    核心不验证 content 的业务格式。

Implementation、Deployment 与 ledger 保持同步占位。
待用户明确批准精确 Ideal revision 后，再制定实施计划，不自动 acceptIdeal。
