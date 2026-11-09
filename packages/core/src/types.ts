export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface HardwareCredential {
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  algorithm: -7;
}

export interface EnrollRequest {
  rpId: string;
  userId: Uint8Array;
  label: string;
  signal: AbortSignal;
}

export interface DeriveRequest {
  rpId: string;
  credential: HardwareCredential;
  prfInput: Uint8Array;
  signal: AbortSignal;
}

export interface HardwareKeyProvider {
  /**
   * 登记外置、不可同步的硬件凭据；取消或不支持 PRF 时拒绝 Promise，喵~
   * @param request 包含 RP、显示标签及取消信号的登记参数，喵~
   */
  enroll(request: EnrollRequest): Promise<HardwareCredential>;
  /**
   * 完成用户在场及用户验证后返回等价 WebAuthn PRF 的 32 字节输出；失败时拒绝 Promise，喵~
   * @param request 原始 PRF 输入，不是已经域分离过的 CTAP 盐，喵~
   */
  deriveSecret(request: DeriveRequest): Promise<Uint8Array>;
}

export interface StoredVault { bytes: Uint8Array; revision?: string }

export interface VaultStore {
  readonly conditionalWrite: 'atomic' | 'best-effort' | 'none';
  /**
   * 读取密文字节及对应版本；不存在时以 NOT_FOUND 拒绝 Promise，喵~
   */
  read(): Promise<StoredVault>;
  /**
   * 完成条件写入并返回对应版本；冲突和未确认的写入不能返回成功，喵~
   * @param bytes 已封存的加密库，喵~
   * @param expectedRevision null 只表示新建，不能代表已有但缺少版本的文件，喵~
   */
  write(bytes: Uint8Array, expectedRevision: string | null): Promise<{ revision: string }>;
}

export interface CipherBlock { iv: string; data: string }
export interface KeySlot {
  label: string;
  credentialId: string;
  publicKey: string;
  algorithm: -7;
  prfInput: string;
  hkdfSalt: string;
  wrappedKey: CipherBlock;
}
export interface VaultHeader {
  format: 'secure-notes';
  version: 1;
  vaultId: string;
  rpId: string;
  keySlots: KeySlot[];
}
export interface VaultEnvelope extends VaultHeader { payload: CipherBlock }
export type SessionStatus = 'empty' | 'locked' | 'authenticating' | 'unlocked';
export interface SessionState {
  status: SessionStatus;
  vaultId?: string;
  keyLabels: readonly string[];
  contentVersion: number;
  snapshotVersion: number;
  canPersist: boolean;
  lockReason?: string;
}
export type PersistenceStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error' | 'read-only';
export interface PersistenceState { status: PersistenceStatus; code?: import('./errors.js').VaultErrorCode }
export type CryptoKeyUsage = 'encrypt' | 'decrypt' | 'deriveKey' | 'deriveBits' | 'sign' | 'verify' | 'wrapKey' | 'unwrapKey';
export interface CryptoKeyHandle {
  readonly algorithm: { name: string };
  readonly extractable: boolean;
  readonly type: 'secret' | 'private' | 'public';
  readonly usages: CryptoKeyUsage[];
}
type GcmParams = { name: 'AES-GCM'; iv: ArrayBuffer; additionalData: ArrayBuffer; tagLength: number };
export interface CryptoRuntime {
  /**
   * 使用平台 CSPRNG 填充并返回字节数组；随机源不可用时抛出异常，喵~
   * @param array 本次请求的独立整数缓冲区，喵~
   */
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  subtle: {
    /** 返回 SHA-256 摘要；失败时拒绝 Promise，喵~ */
    digest(algorithm: 'SHA-256', data: ArrayBuffer): Promise<ArrayBuffer>;
    /** 导入标准 AES/HKDF 密钥；失败时拒绝 Promise，喵~ */
    importKey(format: 'raw', data: ArrayBuffer, algorithm: 'AES-GCM' | 'HKDF', extractable: boolean, usages: CryptoKeyUsage[]): Promise<CryptoKeyHandle>;
    /** 执行固定 HKDF 参数的密钥派生；失败时拒绝 Promise，喵~ */
    deriveKey(algorithm: { name: 'HKDF'; hash: 'SHA-256'; salt: ArrayBuffer; info: ArrayBuffer }, baseKey: CryptoKeyHandle, derived: { name: 'AES-GCM'; length: number }, extractable: boolean, usages: CryptoKeyUsage[]): Promise<CryptoKeyHandle>;
    /** 完成 AES-GCM 加密后返回带认证标签的密文；失败时拒绝 Promise，喵~ */
    encrypt(algorithm: GcmParams, key: CryptoKeyHandle, data: ArrayBuffer): Promise<ArrayBuffer>;
    /** 完整性验证通过后返回明文；验证失败时拒绝 Promise，喵~ */
    decrypt(algorithm: GcmParams, key: CryptoKeyHandle, data: ArrayBuffer): Promise<ArrayBuffer>;
  };
}
