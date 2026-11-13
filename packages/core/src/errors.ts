export type VaultErrorCode =
  | 'INVALID_FORMAT' | 'UNSUPPORTED_VERSION' | 'INVALID_INPUT' | 'TAMPERED'
  | 'WRONG_KEY' | 'LOCKED' | 'STALE_OPERATION' | 'CANCELLED' | 'UNSUPPORTED'
  | 'PRF_UNAVAILABLE'
  | 'RP_MISMATCH' | 'NOT_FOUND' | 'CONFLICT' | 'READ_ONLY' | 'AUTH_FAILED'
  | 'PERMISSION_DENIED' | 'NETWORK' | 'TIMEOUT' | 'SAVE_FAILED';

export class VaultError extends Error {
  /** 只暴露稳定错误码，不携带可能包含凭据的底层异常，喵~ */
  constructor(public readonly code: VaultErrorCode) {
    super(code);
    this.name = 'VaultError';
  }
}

/** 将未知异常收敛为不含敏感上下文的业务错误，喵~ */
export function asVaultError(error: unknown, fallback: VaultErrorCode = 'SAVE_FAILED'): VaultError {
  return error instanceof VaultError ? error : new VaultError(fallback);
}
