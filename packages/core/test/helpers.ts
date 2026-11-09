import { webcrypto } from 'node:crypto';
import { VaultError } from '../src/errors.js';
import { toBase64, buffer } from '../src/bytes.js';
import { toCtapHmacSalt } from '../src/crypto.js';
import { VaultSession } from '../src/session.js';
import type { CryptoRuntime, DeriveRequest, EnrollRequest, HardwareCredential, HardwareKeyProvider, StoredVault, VaultStore } from '../src/types.js';

export const runtime = webcrypto;

export class TestHardware implements HardwareKeyProvider {
  readonly keys = new Map<string, Uint8Array>();
  beforeDerive?: () => Promise<void>;
  /** 模拟登记独立硬件；仅测试代码可生成此软件凭据，喵~ */
  async enroll(_request: EnrollRequest): Promise<HardwareCredential> {
    const id = runtime.getRandomValues(new Uint8Array(32));
    this.keys.set(toBase64(id), runtime.getRandomValues(new Uint8Array(32)));
    return { credentialId: id, publicKey: new Uint8Array([1, 2, 3]), algorithm: -7 };
  }
  /** 用真实 HMAC 模拟硬件 PRF，绝不进入生产导出或 Web 构建，喵~ */
  async deriveSecret(request: DeriveRequest): Promise<Uint8Array> {
    await this.beforeDerive?.();
    const secret = this.keys.get(toBase64(request.credential.credentialId));
    if (!secret) throw new VaultError('WRONG_KEY');
    const key = await runtime.subtle.importKey('raw', buffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await runtime.subtle.sign('HMAC', key, buffer(await toCtapHmacSalt(runtime, request.prfInput))));
  }
}

/** 创建真实 AES-GCM 的测试库，硬件接口由独立测试实现提供，喵~ */
export async function fixture(now?: () => number): Promise<{ session: VaultSession; hardware: TestHardware; bytes: Uint8Array }> {
  const hardware = new TestHardware(); const session = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example', now });
  await session.create(await session.enroll('主密钥'));
  await session.addKey(await session.enroll('备用密钥'));
  await session.addNote('隐私标题', '绝不应出现在密文文件中的中文正文');
  return { session, hardware, bytes: await session.snapshot() };
}

export class MemoryStore implements VaultStore {
  readonly conditionalWrite = 'atomic' as const;
  bytes?: Uint8Array;
  version = 0;
  loseResponse = false;
  writes = 0;
  /** 读取测试存储的当前内容及对应版本，喵~ */
  async read(): Promise<StoredVault> {
    if (!this.bytes) throw new VaultError('NOT_FOUND');
    return { bytes: this.bytes.slice(), revision: `"${this.version}"` };
  }
  /** 原子执行版本检查，用于并发保存及响应丢失场景，喵~ */
  async write(bytes: Uint8Array, expected: string | null): Promise<{ revision: string }> {
    if (expected === null ? !!this.bytes : !this.bytes || expected !== `"${this.version}"`) throw new VaultError('CONFLICT');
    this.bytes = bytes.slice(); this.version++; this.writes++;
    if (this.loseResponse) { this.loseResponse = false; throw new VaultError('TIMEOUT'); }
    return { revision: `"${this.version}"` };
  }
}
