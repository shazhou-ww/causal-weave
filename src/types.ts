declare const endpointBrand: unique symbol;
declare const hashBrand: unique symbol;

export type EndpointId = string & { readonly [endpointBrand]: true };
export type MessageHash = string & { readonly [hashBrand]: true };
export type Frontier = ReadonlyMap<EndpointId, MessageHash>;
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface Message {
  readonly endpointId: EndpointId;
  readonly frontier: Frontier;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface RegisteredMessage extends Message {
  readonly hash: MessageHash;
  readonly sequence: number;
}

export interface InvalidOptionsError {
  readonly code: "INVALID_OPTIONS";
  readonly field: string;
  readonly reason: string;
}
export interface InvalidMessageError {
  readonly code: "INVALID_MESSAGE";
  readonly field: string;
  readonly reason: string;
}
export interface InvalidReadRequestError {
  readonly code: "INVALID_READ_REQUEST";
  readonly reason: string;
}
export interface InvalidFrontierError {
  readonly code: "INVALID_FRONTIER";
  readonly reason: string;
}
export interface UnknownReferenceError {
  readonly code: "UNKNOWN_REFERENCE";
  readonly hash: MessageHash;
}
export interface ReferenceEndpointMismatchError {
  readonly code: "REFERENCE_ENDPOINT_MISMATCH";
  readonly hash: MessageHash;
  readonly expected: EndpointId;
  readonly actual: EndpointId;
}
export interface FrontierNotClosedError {
  readonly code: "FRONTIER_NOT_CLOSED";
  readonly endpointId: EndpointId;
  readonly required: MessageHash;
  readonly declared: MessageHash | null;
}
export interface StaleEndpointTipError {
  readonly code: "STALE_ENDPOINT_TIP";
  readonly endpointId: EndpointId;
  readonly declaredTip: MessageHash | null;
  readonly actualTip: MessageHash | null;
}
export interface ObservationRegressionError {
  readonly code: "OBSERVATION_REGRESSION";
  readonly endpointId: EndpointId;
  readonly required: MessageHash;
  readonly declared: MessageHash | null;
}
export interface InvalidHistoryError {
  readonly code: "INVALID_HISTORY";
  readonly reason: "encoding" | "hash-mismatch" | "missing-dependency" | "fork"
    | "registration" | "causal-declaration" | "hash-collision";
  readonly description: string;
  readonly hashes: readonly MessageHash[];
  readonly endpointId?: EndpointId;
  readonly predecessor?: MessageHash | null;
}
export interface StrategyContractError {
  readonly code: "STRATEGY_CONTRACT";
  readonly operation: string;
  readonly reason: string;
}
export interface LimitExceededError {
  readonly code: "LIMIT_EXCEEDED";
  readonly limit: keyof Limits;
  readonly maximum: number;
  readonly actual: number;
}
export interface HashCalculationError {
  readonly code: "HASH_CALCULATION";
  readonly reason: "unavailable" | "failed";
  readonly cause?: unknown;
}
export interface StorageReadError {
  readonly code: "STORAGE_READ";
  readonly operation: string;
  readonly cause: unknown;
}
export interface StorageWriteError {
  readonly code: "STORAGE_WRITE";
  readonly cause: unknown;
}
export interface SequenceExhaustedError {
  readonly code: "SEQUENCE_EXHAUSTED";
  readonly latestSequence: number;
}
export interface ConcurrentModificationError {
  readonly code: "CONCURRENT_MODIFICATION";
  readonly expectedSequence: number;
  readonly actualSequence: number;
}
export interface AppendOutcomeUnknownError {
  readonly code: "APPEND_OUTCOME_UNKNOWN";
  readonly hash: MessageHash;
  readonly cause: unknown;
}
export interface InvalidObserverError {
  readonly code: "INVALID_OBSERVER";
}
export interface SubscriptionStartError {
  readonly code: "SUBSCRIPTION_START";
  readonly cause: unknown;
}
export interface SubscriptionError {
  readonly code: "SUBSCRIPTION";
  readonly cause: unknown;
}
export interface InvalidHashError {
  readonly code: "INVALID_HASH";
}
export interface InvalidEndpointIdError {
  readonly code: "INVALID_ENDPOINT_ID";
}
export interface InvalidScanRequestError {
  readonly code: "INVALID_SCAN_REQUEST";
  readonly reason: string;
}
export interface InvalidAppendRequestError {
  readonly code: "INVALID_APPEND_REQUEST";
  readonly reason: string;
}
export interface SequenceConflictError {
  readonly code: "SEQUENCE_CONFLICT";
  readonly expectedSequence: number;
  readonly actualSequence: number;
}

export type CreateChannelError = InvalidOptionsError;
export type GetStateError = InvalidHistoryError | StrategyContractError
  | LimitExceededError | HashCalculationError | StorageReadError;
export type SendError = InvalidMessageError | InvalidFrontierError
  | UnknownReferenceError | ReferenceEndpointMismatchError | FrontierNotClosedError
  | StaleEndpointTipError | ObservationRegressionError | InvalidHistoryError
  | StrategyContractError | LimitExceededError | HashCalculationError | StorageReadError
  | StorageWriteError | SequenceExhaustedError | ConcurrentModificationError
  | AppendOutcomeUnknownError;
export type ReadError = InvalidReadRequestError | InvalidFrontierError
  | UnknownReferenceError | ReferenceEndpointMismatchError | FrontierNotClosedError
  | InvalidHistoryError | StrategyContractError | LimitExceededError
  | HashCalculationError | StorageReadError;
export type WatchStartError = InvalidObserverError | SubscriptionStartError;
export type WatchRuntimeError = SubscriptionError | InvalidHistoryError
  | StrategyContractError | LimitExceededError | HashCalculationError | StorageReadError;
export type PersistenceGetError = InvalidHashError | StorageReadError;
export type PersistenceScanError = InvalidScanRequestError | StorageReadError;
export type PersistenceAppendError = InvalidAppendRequestError | SequenceConflictError
  | SequenceExhaustedError | StorageWriteError | AppendOutcomeUnknownError;

export interface ScanRequest {
  readonly afterSequence: number;
  readonly throughSequence: number;
  readonly limit: number;
}
export interface AppendRequest {
  readonly expectedSequence: number;
  readonly message: Message;
  readonly hash: MessageHash;
}
export type Unwatch = () => void;
export interface PersistenceObserver {
  onChange(): void;
  onError(error: SubscriptionError): void;
}
export interface PersistenceStrategy {
  getLatestSequence(): Promise<Result<number, StorageReadError>>;
  get(hash: MessageHash): Promise<Result<RegisteredMessage | undefined, PersistenceGetError>>;
  scan(request: ScanRequest): Promise<Result<readonly RegisteredMessage[], PersistenceScanError>>;
  append(request: AppendRequest): Promise<Result<RegisteredMessage, PersistenceAppendError>>;
  watch(observer: PersistenceObserver): Result<Unwatch, WatchStartError>;
}
export interface SendReceipt {
  readonly message: RegisteredMessage;
  readonly currentFrontier: Frontier;
}
export interface ReadRequest {
  readonly after: Frontier;
  readonly limit: number;
}
export interface ReadPage {
  readonly messages: readonly RegisteredMessage[];
  readonly nextFrontier: Frontier;
  readonly hasMore: boolean;
}
export interface ChannelState {
  readonly currentFrontier: Frontier;
}
export interface ChannelObserver {
  onChange(state: ChannelState): void;
  onError(error: WatchRuntimeError): void;
}
export interface Channel {
  send(message: Message): Promise<Result<SendReceipt, SendError>>;
  read(request: ReadRequest): Promise<Result<ReadPage, ReadError>>;
  getState(): Promise<Result<ChannelState, GetStateError>>;
  watch(observer: ChannelObserver): Result<Unwatch, WatchStartError>;
}
export interface Limits {
  readonly maxIdBytes: number;
  readonly maxContentTypeBytes: number;
  readonly maxContentBytes: number;
  readonly maxEnvelopeBytes: number;
  readonly maxFrontierEntries: number;
  readonly maxPageMessages: number;
  readonly maxPageBytes: number;
  readonly maxHistoryNodes: number;
  readonly maxNodeReads: number;
  readonly scanBatchSize: number;
  readonly cacheSize: number;
}
export interface ChannelOptions {
  readonly persistence: PersistenceStrategy;
  readonly limits?: Partial<Limits>;
}
