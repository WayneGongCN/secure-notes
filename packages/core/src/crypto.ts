import { buffer, fromBase64, toBase64, utf8 } from './bytes.js';
import { VaultCodec } from './codec.js';
import { VaultError } from './errors.js';
import type { CipherBlock, CryptoKeyHandle, CryptoRuntime, HardwareCredential, KeySlot, Note, VaultEnvelope, VaultHeader } from './types.js';

/** 将 WebAuthn 原始输入转换为直接 CTAP 客户端需要的域分离盐，喵~ */
export async function toCtapHmacSalt(crypto: CryptoRuntime, input: Uint8Array): Promise<Uint8Array> {
  const prefix = utf8('WebAuthn PRF\0');
  const bytes = new Uint8Array(prefix.length + input.length);
  bytes.set(prefix); bytes.set(input, prefix.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)));
}

export class VaultCrypto {
  /** 注入标准密码学运行时，避免绑定浏览器或 Node 专属模块，喵~ */
  constructor(readonly runtime: CryptoRuntime) {}

  /** 生成独立随机字节，不使用可预测的随机源，喵~ */
  random(length: number): Uint8Array { return this.runtime.getRandomValues(new Uint8Array(length)); }

  /** 生成不携带用户信息的随机标识，喵~ */
  id(): string { return [...this.random(16)].map(b => b.toString(16).padStart(2, '0')).join(''); }

  /** 导入仅供 AES-GCM 使用且不可导出的密钥句柄，喵~ */
  async importKey(raw: Uint8Array): Promise<CryptoKeyHandle> {
    return this.runtime.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  /** 使用唯一随机 nonce 和认证上下文生成密文，喵~ */
  async encrypt(key: CryptoKeyHandle, bytes: Uint8Array, aad: Uint8Array): Promise<CipherBlock> {
    const iv = this.random(12);
    const data = await this.runtime.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad), tagLength: 128 }, key, buffer(bytes));
    return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }

  /** 完整性验证成功后才交付解密结果，喵~ */
  async decrypt(key: CryptoKeyHandle, block: CipherBlock, aad: Uint8Array): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.runtime.subtle.decrypt({ name: 'AES-GCM', iv: buffer(fromBase64(block.iv)), additionalData: buffer(aad), tagLength: 128 }, key, buffer(fromBase64(block.data))));
    } catch { throw new VaultError('TAMPERED'); }
  }

  /** 通过 HKDF 将已验证的 PRF 输出约束到指定库和硬件凭据，喵~ */
  private async wrappingKey(secret: Uint8Array, vaultId: string, slot: Pick<KeySlot, 'credentialId' | 'hkdfSalt'>): Promise<CryptoKeyHandle> {
    if (secret.length !== 32) throw new VaultError('UNSUPPORTED');
    const material = await this.runtime.subtle.importKey('raw', buffer(secret), 'HKDF', false, ['deriveKey']);
    return this.runtime.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buffer(fromBase64(slot.hkdfSalt)), info: buffer(utf8(`secure-notes/v1/wrap\0${vaultId}\0${slot.credentialId}`)) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** 固定单个包装槽的认证上下文，喵~ */
  private slotAad(header: Pick<VaultHeader, 'vaultId' | 'rpId'>, slot: Omit<KeySlot, 'wrappedKey'>): Uint8Array {
    return utf8(JSON.stringify(['secure-notes', 1, header.vaultId, header.rpId, slot.label, slot.credentialId, slot.publicKey, slot.algorithm, slot.prfInput, slot.hkdfSalt]));
  }

  /** 为独立硬件创建库密钥的包装槽，调用后清理 PRF 输出，喵~ */
  async wrap(raw: Uint8Array, secret: Uint8Array, header: Pick<VaultHeader, 'vaultId' | 'rpId'>, credential: HardwareCredential, label: string, prfInput: Uint8Array): Promise<KeySlot> {
    const base: Omit<KeySlot, 'wrappedKey'> = { label, credentialId: toBase64(credential.credentialId), publicKey: toBase64(credential.publicKey), algorithm: credential.algorithm, prfInput: toBase64(prfInput), hkdfSalt: toBase64(this.random(32)) };
    try {
      const key = await this.wrappingKey(secret, header.vaultId, base);
      return { ...base, wrappedKey: await this.encrypt(key, raw, this.slotAad(header, base)) };
    } finally { secret.fill(0); }
  }

  /** 解封库密钥并验证包装完整性，调用后清理 PRF 输出，喵~ */
  async unwrap(secret: Uint8Array, header: VaultHeader, slot: KeySlot): Promise<Uint8Array> {
    try {
      const key = await this.wrappingKey(secret, header.vaultId, slot);
      const raw = await this.decrypt(key, slot.wrappedKey, this.slotAad(header, slot));
      if (raw.length !== 32) { raw.fill(0); throw new VaultError('TAMPERED'); }
      return raw;
    } finally { secret.fill(0); }
  }

  /** 封存包括标题和时间在内的整个笔记集合，喵~ */
  async seal(header: VaultHeader, key: CryptoKeyHandle, notes: readonly Note[]): Promise<VaultEnvelope> {
    const bytes = utf8(JSON.stringify({ notes }));
    try { return { ...header, payload: await this.encrypt(key, bytes, VaultCodec.header(header)) }; }
    finally { bytes.fill(0); }
  }

  /** 解密并校验笔记集合，不向调用方暴露原始解密缓冲区，喵~ */
  async open(envelope: VaultEnvelope, key: CryptoKeyHandle): Promise<Note[]> {
    const bytes = await this.decrypt(key, envelope.payload, VaultCodec.header(envelope));
    try { return VaultCodec.notes(bytes); } finally { bytes.fill(0); }
  }
}
