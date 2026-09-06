/** Stable categories for expected State Contract Guard failures. */
export type GuardErrorCode =
  | "GUARD_AUTH_SETUP_PATH_INVALID"
  | "GUARD_CONFIG_PATH_INVALID"
  | "GUARD_CONTRACT_NOT_FOUND"
  | "GUARD_CONTRACT_PATH_INVALID"
  | "GUARD_CONTRACT_LOCKED"
  | "GUARD_CONTRACT_STALE"
  | "GUARD_JSON_EXISTS"
  | "GUARD_JSON_PATH_INVALID"
  | "GUARD_JSON_WRITE_FAILED"
  | "GUARD_PROPOSAL_INVALID"
  | "GUARD_SCENARIO_PATH_INVALID"
  | "GUARD_SHARD_AUTH_UNSUPPORTED"
  | "GUARD_SHARD_BUNDLE_EXISTS"
  | "GUARD_SHARD_BUNDLE_WRITE_FAILED"
  | "GUARD_SHARD_MERGE_FAILED"
  | "GUARD_SHARD_MERGE_INVALID"
  | "GUARD_SHARD_PLAN_EXPIRED"
  | "GUARD_SHARD_PLAN_INVALID"
  | "GUARD_SHARD_PLAN_MISMATCH"
  | "GUARD_SHARD_PLAN_PATH_INVALID"
  | "GUARD_SHARD_PLAN_WRITE_FAILED"
  | "GUARD_WORKSPACE_INVALID";

/** An expected guard setup or safe-publication failure. */
export class GuardError extends Error {
  readonly code: GuardErrorCode;
  readonly path: string | undefined;

  constructor(
    code: GuardErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GuardError";
    this.code = code;
    this.path = path;
  }
}
