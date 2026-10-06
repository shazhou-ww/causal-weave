import type { GetStateError, ReadError, Result, SendError } from "./types.js";
import { err, ok } from "./values.js";

export type OperationError = SendError | ReadError;
export class Failure extends Error {
  constructor(readonly error: OperationError) { super(error.code); }
}
export function fail(error: OperationError): never { throw new Failure(error); }
export function stateError(error: OperationError): error is GetStateError {
  return error.code === "INVALID_HISTORY" || error.code === "STRATEGY_CONTRACT"
    || error.code === "LIMIT_EXCEEDED" || error.code === "HASH_CALCULATION" || error.code === "STORAGE_READ";
}
export function sendError(error: OperationError): error is SendError {
  return error.code !== "INVALID_READ_REQUEST";
}
export function readError(error: OperationError): error is ReadError {
  return stateError(error) || error.code === "INVALID_READ_REQUEST" || error.code === "INVALID_FRONTIER"
    || error.code === "UNKNOWN_REFERENCE" || error.code === "REFERENCE_ENDPOINT_MISMATCH"
    || error.code === "FRONTIER_NOT_CLOSED";
}
export async function capture<T, E extends OperationError>(
  action: () => Promise<T>, accepts: (error: OperationError) => error is E,
): Promise<Result<T, E>> {
  try { return ok(await action()); } catch (error) {
    if (error instanceof Failure && accepts(error.error)) return err(error.error);
    throw error;
  }
}
