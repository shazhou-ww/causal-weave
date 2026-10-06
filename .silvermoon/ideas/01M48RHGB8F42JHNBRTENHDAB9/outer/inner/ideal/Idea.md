# causal-weave：多端因果 channel 核心与公共 API 草案

## 意图

设计一个独立于持久化、网络与业务的 TypeScript 包 causal-weave。
以内容寻址节点、多单写者链和稀疏向量前沿表达多端因果历史，
让应用可以准确声明消息依据，adapter 可以据此原子登记、合并和同步。

本文是供用户讨论的完整公共契约草案，不是已批准实现计划。
创建、提交或发布本文不代表 acceptIdeal；当前不实施库，也不发布 npm。

## 背景

最初需求来自 Silvermoon 的多端交互，但公共模型不得包含 Silvermoon 业务身份、
ideaId、审批命令、生命周期或 reducer，也不限定两个端。
Silvermoon 将来如何使用本包属于其独立设计，不在此仓库自动迁移。

理论定位：多单写者链上的内容寻址因果历史 / 稀疏向量时钟，
加上每端乐观 CAS；不是共识协议、认知证明或业务冲突消解算法。

来源仅供追溯：shazhou-ww/silvermoon 的 idea-event-merkle-dag，
ULID 01M4868ZD9M9C1WV6XEXYCX264；primary commit
683c0ca97030b32acc69c666d0833d65972affbc，Ideal revision
d5e8eb251567eb60bd4af21fb280b0b0c5944e62。旧双端候选与分段设计不构成本包契约。

## 期望结果

应用只需要绑定自己的 Endpoint，提供真实的发送前沿和内容，
即可取得可验证节点与明确的提交前提。不同 adapter 对同一节点得到相同字节与 hash。
发送者不会被迫观察对端最新 tip，也不会在节点里被伪写未观察到的消息。

核心能明确区分结构非法、缺依赖、跨 channel、前沿不闭合、观测倒退和 fork。
合法计划不等于持久化成功；准确相同节点重投不产生新节点。

## 范围

### 范围内

- 严格规范编码、解码和 SHA-256 完整性核验。
- 每端链、稀疏 frontier、祖先 / 并发 / 闭包校验。
- 固定一致输入快照、候选追加、CAS 前提、逻辑合并计划。
- frontier delta、确定性因果遍历、准确节点重投。
- TypeScript 公共类型、错误结构、资源限额和跨运行时测试向量的设计。

### 范围外

- 文件路径、数据库、Git、网络、锁、事务、fsync、恢复、分段、offset、index、cache。
- 端 ID 生成、重连复用、保存、认证、授权、撤销、业务 join。
- 业务 events 清单、批内业务有效性、批准、生命周期、reducer、业务冲突解决。
- exactly-once、任务完成、共识、可证明业务处理、自动 GC。
- Silvermoon 的实现或迁移；未经另行授权的 npm 发布。

## 约束

### 已由用户确认

1. 首个实现使用 TypeScript，面向 Node.js 与浏览器，不依赖 Silvermoon 业务代码。
2. 内容 c 是不透明 Uint8Array，由应用编码，可以装一批有序 events。
3. 使用 SHA-256 与确定性二进制 envelope；定义的是库 API，不是网络协议，
   Envelope 不包含 protocolVersion，也不编码协议版本字段。
4. 变长字段带长度，frontier 以端 ID 的 UTF-8 字节排序，不做 Unicode 归一化。
5. Web Crypto hash API 异步；输入 / 输出字节必须隔离，防止外部修改。
6. 项目采用 Silvermoon v2 管理 idea，发布讨论稿不代表批准 API。
7. channelId 只作为上层 API 的路由上下文，不进入 Envelope、规范字节或 hash，
   也不作为外部 hash 隔离上下文。相同节点可在不同 channel 中具有相同 hash。

除上述选择与已讨论的模型边界外，下文具体签名、规范编码布局、限额和接口名称均为提案。

### 数学模型与不变量

每个 channel 数学上有可数无限逻辑端；从未出现的端处于 bottom。
实际 frontier 是有限支撑映射 endpointId -> messageHash，缺失维度等于 bottom。
每次校验仅在当前 channel 快照的节点集合内解析 hash，并核对对应端链。
channel 的路由、存储归属和输入集合隔离由上层保证，节点字节不证明 channel 归属。

以 a <= b 表示 a 是 b 的同端链祖先或相等；bottom <= 任意合法版本。
不同端的 hash 不能直接比较；同端不可比较的节点是 fork，不是普通并发。
合法 frontier 的覆盖按所有维度的上述关系比较，不能排序 hash 字符串代替。

设节点 n 的发送前沿为 V，归属为 e，hash 为 h：

- n 的同端前驱就是 V[e]；缺失时为 bottom，不额外编码一个 prev 字段。
- n.causalFrontier = V[e := h]；这是派生属性，不参与自身 hash。
- V 引用的每个节点 q 都必须存在于当前快照中，且 endpointId 对应引用维度。
- 对每个被引用的 q，q.causalFrontier <= V，保证传递因果闭包。
- 本端前驱 p 存在时，还必须满足 p.causalFrontier <= V，保证已观测位置不倒退。
- 验证不能补 refs、补维度或删除显式非法维度来使输入通过。

闭包提案示例：B1 观察 A1；若 C1 引用 B1，则其发送前沿也必须覆盖 A1。
只声明 B1 而遗漏 A 维度属于 FRONTIER_NOT_CLOSED，不自动替用户补入 A1。
同端链上的祖先可以由 tip 隐含覆盖，不要求在一个维度中列举所有祖先。

## 公共 API 提案

### 1. 基础类型、值语义与结果

下列声明用于讨论签名，不是已可编译的实现文件。
省略的 private brand 将由包内部定义，用户不能通过类型断言绕过运行时校验。

```ts
type ChannelId = string & ChannelIdBrand;
type EndpointId = string & EndpointIdBrand;
type MessageHash = string & MessageHashBrand;

type Frontier = ReadonlyMap<EndpointId, MessageHash>;
type Version = MessageHash | null; // null 只表示查询 / CAS 中的 bottom

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WeaveError };

interface AddressedNode {
  readonly hash: MessageHash;
  readonly bytes: Uint8Array;
}

interface Envelope {
  readonly endpointId: EndpointId;
  readonly observedFrontier: Frontier;
  readonly content: Uint8Array;
}

interface VerifiedNode {
  readonly hash: MessageHash;
  readonly envelope: Envelope;
  readonly causalFrontier: Frontier;
  readonly bytes: Uint8Array;
}
```

VerifiedNode 只证明 envelope 严格编码且 hash 一致，不代表依赖齐全、无 fork 或登记成功。
链和闭包事实只有经过 snapshot 校验后才成立。

ReadonlyMap / readonly Uint8Array 的 TypeScript 类型不提供运行时不可变保证。
提案采用内部私有副本，公共 getter 返回独立副本；不能只依赖 Object.freeze。
固定 snapshot 不保留调用方可变 Map / 数组 / buffer 的引用。
API 不接受可变外部 VerifiedNode 对象作为可信内部节点句柄。

```ts
function parseChannelId(value: string): Result<ChannelId>;
function parseEndpointId(value: string): Result<EndpointId>;
function parseMessageHash(value: string): Result<MessageHash>;

function createFrontier(
  entries: Iterable<readonly [EndpointId, MessageHash]>
): Result<Frontier>;

function frontierVersion(
  frontier: Frontier, endpoint: EndpointId
): Version;
```

ID 提案：非空、Unicode scalar value 字符串，拒绝孤立 surrogate，
不 trim、不改大小写、不归一化，按 UTF-8 精确身份区分。
字符形状和最大字节长度仍待讨论。
hash 提案：恰好 64 位小写十六进制 SHA-256，不接受多种等价文本形式。
createFrontier 拒绝重复 key，即使值相同也不静默覆盖。
规范 frontier 不接受 null / undefined 值；空维度用缺失项表达。
frontierVersion 的 null 是查询结果，不会进入 envelope。

### 2. 配置与纯编码 / 完整性

```ts
interface Limits {
  readonly maxIdBytes: number;
  readonly maxFrontierEntries: number;
  readonly maxContentBytes: number;
  readonly maxEnvelopeBytes: number;
  readonly maxSnapshotNodes: number;
  readonly maxInputBytes: number;
  readonly maxTraversalNodes: number;
}

interface CoreOptions {
  readonly limits: Limits;
}

function createCore(options: CoreOptions): Result<WeaveCore>;

interface WeaveCore {
  encodeEnvelope(envelope: Envelope): Result<Uint8Array>;
  decodeEnvelope(bytes: Uint8Array): Result<Envelope>;
  hashEnvelope(envelope: Envelope): Promise<Result<MessageHash>>;
  verifyNode(node: AddressedNode): Promise<Result<VerifiedNode>>;
  createSnapshot(input: SnapshotInput): Promise<Result<ChannelSnapshot>>;
}
```

提案不隐式读取环境变量、不默认联网、不自动安装 hash provider。
hashEnvelope 先规范编码，再计算 SHA-256。
verifyNode 严格解码并比对 hash，不修复不规范输入。
decodeEnvelope 不证明依赖存在；不能将解码成功描述为 channel 接受成功。

所有 Limits 必须为正 safe integer，缺失配置或不支持的运行环境显式失败。
操作受 maxInputBytes 等约束，先检查外部声明长度再分配 / 遍历；
结果不是被截断的成功。具体建议数值、Node.js 最低版本和浏览器矩阵待讨论。

### 3. 规范编码布局提案

用于内容寻址与严格解码的确定性字节布局如下，不定义网络协议：

```text
ASCII("causal-weave") || 0x00
lengthPrefixedUtf8(endpointId)
u32be(frontierEntryCount)
重复 entryCount 次：
  lengthPrefixedUtf8(endpointId)
  rawSha256(32 bytes)
lengthPrefixedBytes(content)
```

所有 length prefix 为 u32be 字节长度，不是字符长度；空 content 合法。
同一 envelope 的 frontier key 必须按 UTF-8 字节严格递增；比较无符号字节，
不使用 localeCompare 或 UTF-16 默认字符串排序。
端归属、发送前沿和内容均参与 hash，channelId 不参与。
固定前缀 ASCII("causal-weave") || 0x00 提供库的 hash 域隔离，
不提供 channel 隔离，也不携带版本。
hash 不作为 envelope 字段；AddressedNode 是携带 hash 与规范字节的 API 值。

解码拒绝错误固定前缀、无效 UTF-8、重复 / 乱序 key、越界长度、
不完整字段、超限和尾随字节。不得用宽松 UTF-8 replacement 代替错误。
合法字节严格解码后重编码必须逐字节相同。
未来若改变规范编码或 hash 规则，必须明确其兼容性与内容地址影响；
不能以自动猜测格式或向 Envelope 添加协议版本字段来代替 API 兼容性设计。

### 4. 固定一致快照

```ts
interface SnapshotInput {
  readonly channelId: ChannelId;
  readonly nodes: readonly AddressedNode[];
  readonly currentFrontier: Frontier;
}

interface ChannelSnapshot {
  readonly channelId: ChannelId;
  readonly currentFrontier: Frontier;

  getNode(hash: MessageHash): Result<VerifiedNode>;
  validateFrontier(frontier: Frontier): Result<ValidatedFrontier>;
  compareVersions(
    endpoint: EndpointId, left: Version, right: Version
  ): Result<VersionRelation>;
  compareFrontiers(
    left: Frontier, right: Frontier
  ): Result<FrontierRelation>;
  covers(cover: Frontier, covered: Frontier): Result<boolean>;
  traverse(frontier: Frontier): Result<readonly VerifiedNode[]>;
  delta(request: DeltaRequest): Result<Delta>;
  bindEndpoint(endpoint: EndpointId): Result<Endpoint>;
  planMerge(nodes: readonly AddressedNode[]): Promise<Result<MergePlan>>;
}

type VersionRelation = "equal" | "ancestor" | "descendant" | "fork";
type FrontierRelation = "equal" | "before" | "after" | "concurrent";
```

首版建议完整有限历史快照：nodes 必须包含声明 currentFrontier 的全部因果历史，
且没有未纳入 currentFrontier 的额外 tip；currentFrontier 必须恰为各端唯一最大节点。
空 nodes + 空 frontier 是合法空 channel。nodes 的输入顺序不影响结果。
adapter 保证输入来自一个一致快照；核心不能证明外部存储真的如此。
SnapshotInput.channelId、ChannelSnapshot.channelId 与 Endpoint.channelId
仅标识上层已路由的 channel 上下文，不进入节点字节或 hash。
adapter 只能提供目标 channel 已登记的节点；全局 blob 存在不等于该 channel 已登记。
同一精确节点允许独立登记到多个 channel，核心不能据字节推断它来自哪里。
核心验证完整性、缺依赖、端归属、前沿闭包、同端观测单调性及 fork。
重复相同 AddressedNode 可幂等去重；相同 hash 不同字节显式报错。

当前快照不存在的 hash 不能当作 bottom，也不能从其他 channel 或全局 blob 集合自动解析。
端归属不符的节点不能当作合法该维度。
上层若把其他 channel 的完整合法历史误路由为本 channel 输入，核心无法检测来源错误；
不能承诺跨 channel 引用的内在识别或拒绝。
compareVersions 的 fork 是诊断值；compareFrontiers 遇到任何 fork 返回错误，
不能把同端 fork 归为跨端 concurrent。
covers 只在两侧前沿均合法时返回 true / false；输入非法必须返回 error。

```ts
interface ValidatedFrontier {
  readonly frontier: Frontier;
}
```

ValidatedFrontier 只在产生它的快照内有证明意义，不能跨快照免检。
其公开值可以复制保存，但传回另一个 snapshot 时要重新校验。
首版不提供隐式异步 getNode 回调；完整历史过大时明确报限额。
按需读取未来只能作为固定、只读、一致快照边界，不能接任意变化中的数据库 getter。
是否首版就支持此边界，是待讨论的重大范围选择。

### 5. 绑定 Endpoint 与候选追加

```ts
interface Endpoint {
  readonly channelId: ChannelId;
  readonly id: EndpointId;
  readonly tip: Version;
  readonly others: Frontier;

  planAppend(request: AppendRequest): Promise<Result<AppendPlan>>;
}

interface AppendRequest {
  readonly causalFrontier: Frontier;
  readonly content: Uint8Array;
}

interface AppendPlan {
  readonly node: VerifiedNode;
  readonly causalFrontier: Frontier;
  readonly snapshotFrontier: Frontier;
  readonly preconditions: AppendPreconditions;
}

interface AppendPreconditions {
  readonly channelId: ChannelId;
  readonly endpointId: EndpointId;
  readonly expectedTip: Version;
  readonly requiredNodes: readonly MessageHash[];
}
```

Endpoint 绑定到一个固定 snapshot，而不是可变实时端。
调用方发送时不用再自报 A/B、upstream/downstream 或本端 endpointId。
others 只返回快照中其他已出现端；无限个 bottom 端不会被枚举。
bindEndpoint 可绑定此前未出现的合法 ID，tip 为 null；
它不创建持久化记录、不验证授权，也不预留身份。

发送时 request.causalFrontier 就是发送前沿 V，不是返回的新节点前沿：

1. 验证 V 的形状、引用节点存在于当前快照、端归属；不静默补全。
2. V[本端] 必须等于 snapshot 本端 tip，否则 STALE_SELF_TIP。
3. 若本端前驱存在，检查其 causalFrontier <= V，否则 OBSERVATION_REGRESSION。
4. 检查传递闭包，否则 FRONTIER_NOT_CLOSED。按此顺序优先诊断本端观测倒退。
   对端版本可以落后于 snapshot.currentFrontier，不能强制拉到最新 tip。
5. 规范编码、计算 hash，生成 node 与 V[本端 := h]。
6. requiredNodes 提案为 V 引用的直接节点 hash，按原始 hash 字节排序去重。
   adapter 必须保证已验证依赖的完整闭包仍不可变且可访问，不能只保留直接节点。

snapshotFrontier 是规划时视图；不是提交时 currentFrontier。
同一旧 snapshot 上可以产生多个合法候选，但同端最终只能登记一个；
另一个 CAS 冲突，不因此获得新 tip 或自动改前沿。
不同 snapshot / 同一 ID 的竞争归 adapter 处理，不声称本端天然防止身份盗用。

### 6. adapter 提交契约（不是核心 I/O API）

核心不提供 commit、save、fetch 或 applyToDatabase。
下面只是建议给 adapter 的集成结构，是否随包导出这些类型仍待讨论：

```ts
type AppendCommitResult =
  | {
      readonly status: "committed";
      readonly nodeHash: MessageHash;
      readonly causalFrontier: Frontier;
      readonly currentFrontier: Frontier;
    }
  | {
      readonly status: "already-present";
      readonly nodeHash: MessageHash;
      readonly causalFrontier: Frontier;
      readonly currentFrontier: Frontier;
    }
  | {
      readonly status: "conflict";
      readonly actualTip: Version;
      readonly currentFrontier: Frontier;
    };
```

adapter 必须在同一原子事务中核对路由 channel / 本端 expectedTip、
保证依赖已登记于该 channel，
登记精确 node.bytes 并更新本端 tip。其他端并发前进本身不使 append 失败。
端链和节点字节必须不可变；GC / 删除不能绕过 requiredNodes 的闭包保护。
fork 被其他写入引入时不能仍按旧快照提交。

already-present 必须证明目标 channel 内有相同 hash、相同字节，
且该节点位于该 channel 的合法登记链上；
只见到全局 blob 或其他 channel 的登记不够。即使本端 tip 已有后继，
也可报告相同历史节点重投。
不得重新包装内容、添加时间或生成新节点来伪造幂等。

currentFrontier 必须来自同一提交事务的一致结果视图，可能含未观察到的其他端。
业务收到该值后自行决定拉取，不得直接声称已经观察 / 处理了这些节点。
I/O 错误由 adapter 显式报告，不能伪装为 committed、already-present 或空结果。
若 CAS 失败，重新读取 snapshot 并核验；不得静默用最新前沿重写原节点。

### 7. 逻辑合并与精确重投

```ts
interface MergePlan {
  readonly nodesToInsert: readonly AddressedNode[];
  readonly alreadyPresent: readonly MessageHash[];
  readonly proposedFrontier: Frontier;
  readonly preconditions: MergePreconditions;
}

interface MergePreconditions {
  readonly channelId: ChannelId;
  readonly expectedCurrentFrontier: Frontier;
}
```

planMerge 对输入严格验 hash / 编码，再与 snapshot 做集合并集，允许乱序输入。
缺依赖时不返回部分成功计划；完整诊断后由调用方补齐并重新请求。
任何同端分叉都拒绝整个候选，记录端、共同前驱和冲突的后继 hash，不选赢家。
新节点依赖只可来自 snapshot 或同批输入，不能隐式从其他 channel 读取。
上层负责将该批输入路由到目标 channel 并授权导入；核心仅验证候选并集的结构，
不判断节点的源 channel，也不禁止相同历史由上层显式导入另一个 channel。
同一精确节点重投列入 alreadyPresent；同 hash 异字节是完整性冲突。

nodesToInsert 按确定性因果顺序输出原始规范字节；不重 hash 改 envelope。
proposedFrontier 是候选并集的最大前沿，不是已经提交的 currentFrontier。
初版 merge 提案使用完整 expectedCurrentFrontier CAS，避免同时引入互斥分支；
这比 append 的单端 CAS 更保守，是否改为逐端 CAS + 明确依赖存在前提待讨论。
空计划不证明任何外部提交或远端同步成功。

### 8. delta 与确定性遍历

```ts
interface DeltaRequest {
  readonly from: Frontier;
  readonly to: Frontier;
}

interface Delta {
  readonly from: Frontier;
  readonly to: Frontier;
  readonly nodes: readonly AddressedNode[];
}
```

令 Past(F) 为 F 的完整因果历史（包含引用节点自身）。
delta 返回 Past(to) 减 Past(from)，按下面的确定性因果顺序输出。
两侧前沿都必须在 snapshot 合法且闭合；不要求 from <= to，
因此支持并发视图间的补齐，也允许空差集。
接收端必须确实持有 Past(from)，剩余依赖才由 delta 的 nodes 补足；
from 声明不是核心能认证的远端持有证明。
接收端用 planMerge 合并，不把 to 当作覆盖 / 删除自己现有历史的命令。

traverse 返回 Past(frontier) 的确定性拓扑序：
先满足全部直接依赖；多个可输出节点按 endpointId 的 UTF-8 字节序，
再按 hash 原始字节序打破平局。输入排列和 Map 插入顺序不得影响结果。
这只是遍历顺序，不能导出真实时间、认知完成或 last-write-wins。
首次版本建议有限数组结果，受 maxTraversalNodes / maxInputBytes 约束；
分页 / streaming 不在未批准时擅自加入。

### 9. 错误与失败边界

```ts
type ErrorCode =
  | "INVALID_ID" | "INVALID_HASH" | "INVALID_FRONTIER"
  | "INVALID_OPTIONS" | "LIMIT_EXCEEDED"
  | "INVALID_ENCODING" | "HASH_MISMATCH"
  | "HASH_COLLISION" | "CRYPTO_UNAVAILABLE" | "CRYPTO_FAILURE"
  | "UNKNOWN_HASH" | "MISSING_DEPENDENCIES"
  | "ENDPOINT_MISMATCH"
  | "FRONTIER_NOT_CLOSED" | "OBSERVATION_REGRESSION"
  | "STALE_SELF_TIP" | "INVALID_CURRENT_FRONTIER"
  | "FORK" | "CAUSAL_CYCLE";

interface WeaveError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: ErrorDetails;
}
```

ErrorDetails 提案是按 code 判别的联合类型，而非 any / 任意字符串字典：

- 格式错误：字段路径、字节 offset、原因；不把内容 c 放入错误或日志。
- 限额错误：限额名、上限、实际值；不截断输入后返回成功。
- 未知 / 缺依赖：hash 列表，以及引用的节点 / 维度。
- 端不匹配：expected 与 actual。channel 路由错误由上层检测和显式报告，
  不从无 channel 字段的节点中伪造 CHANNEL_MISMATCH 诊断。
- 不闭合 / 倒退：endpoint、requiredVersion、declaredVersion。
- tip 过期：expectedTip 与 declaredTip。
- fork：endpoint、commonPredecessor、两个冲突后继；证据来自实际链。
- 完整性冲突：hash；不隐式选择其中一份字节。

库不默认 console.log、不接日志文件；Result 的失败分支就是显式错误接口。
正常无关的两个前沿才返回 concurrent；缺依赖和 fork 不是正常并发结果。
只转换已识别的输入 / crypto 环境错误，不能广泛 catch 程序缺陷并伪装成用户错误。
API 的可预期失败用 Result，未识别的程序错误仍 throw / reject；
是否采用全部 Result 或分类异常是待讨论项。

### 10. 应用使用示例

```ts
const snapshotResult = await core.createSnapshot(adapterSnapshotInput);
if (!snapshotResult.ok) return report(snapshotResult.error);
const snapshot = snapshotResult.value;

const endpointResult = snapshot.bindEndpoint(myEndpointId);
if (!endpointResult.ok) return report(endpointResult.error);

const planResult = await endpointResult.value.planAppend({
  causalFrontier: actuallyObservedFrontier,
  content: appEncodedOrderedEvents,
});
if (!planResult.ok) return report(planResult.error);

// 以下是应用自己实现的存储调用，不属于 causal-weave。
const receipt = await adapter.commitAppend(planResult.value);
// receipt.currentFrontier 可提示继续拉取，不能当成消息已观测依据。
```

端 ID 的生成、复用与权限在上述调用之前由应用决定。
actuallyObservedFrontier 必须由应用真实选择；核心只能验证结构合法性。
业务可以把 setAlias + setLanguage 编码为一个有序批次，共享同一个 envelope；
核心不要求每个业务 event 单独节点，也不理解这两个业务命令。

## 契约验证目标（批准后的实现依据）

1. Node.js 与浏览器对同一向量生成逐字节相同 envelope / hash；
   key 插入顺序变化不改变 hash，端 / V / c 的变化影响 hash。
   相同节点在不同 channel 中字节与 hash 相同。
2. 空 channel、新端首次追加、任意有限多端和缺失 bottom 均有向量。
3. 落后但合法的对端 tip 可发送；本端 tip 过期、观测倒退、缺闭包必须拒绝。
4. 用同端链 ancestry 验证，不依赖字典序、整数序号或时间。
5. 同端并发候选能各自规划，但 adapter CAS 只允许一个登记；
   不同端并发追加不被本端 CAS 无故阻断。
6. 同一节点精确重投、乱序合并、缺依赖、fork 有明确结果。
   不在目标快照或同批输入中的依赖报告缺失，不查询其他 channel；
   全局 blob 或其他 channel 登记不能当作本 channel 的 already-present。
7. delta 满足精确集合差与依赖条件；拓扑顺序可复现且所有依赖先于节点。
8. 无效 UTF-8、surrogate、重复 key、尾随字节、错误固定前缀、截断及超限严格拒绝。
9. 修改外部输入 / 输出 Map、数组、buffer 不改变既有 snapshot 和节点事实。
10. snapshotFrontier、causalFrontier、proposedFrontier 与提交 currentFrontier
    用可观察案例区分；不产生“合法计划即提交成功”的接口。

## 待解决问题

1. 是否接受本文传递闭包定义：引用 q 时 V 必须覆盖 q.causalFrontier？
2. 是否接受完整有限快照作为首版范围，还是必须首版支持按需一致读取？
3. Frontier 选择 ReadonlyMap，还是冻结的 null-prototype record / entries 值对象？
4. 是否接受绑定 snapshot 的 Endpoint、planAppend 命名与发送参数 causalFrontier？
   是否把参数改名 observedFrontier，以减少与返回 causalFrontier 混淆？
5. 是否接受本规范编码布局 / ID 与 hash 表示？ID 允许哪些字符、上限如何设置？
6. Node.js / 浏览器支持矩阵、ESM / CJS、包 exports、最低 TS 版本与工具链尚未确定。
7. Limits 的具体数值是否提供默认 profile？是否需要 AbortSignal / 流式接口？
8. 合并提交采用完整前沿 CAS，还是逐端 CAS 与依赖保持前提？
9. adapter receipt 类型是否随核心导出，还是只作为文档集成约定？
10. Result / 错误判别结构是否满足调用者需求；缺依赖诊断是否需要批量全部证据？
11. 上层 channel 路由接口是否需要独立的绑定 Channel 对象，
    还是保留 SnapshotInput.channelId 与计划前提中的路由标识？
    无论选择哪种接口，channelId 均不进入 Envelope 或 hash。
12. 包许可、发布接口和 npm 发布授权尚未确定；本文不触发发布。

Implementation / Deployment 及 ledger 保持同步占位，待本文讨论完成、
精确 Ideal revision 获得用户明确批准后再制定实施计划。
