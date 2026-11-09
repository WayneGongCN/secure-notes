import { fromBase64, text, utf8 } from './bytes.js';
import { VaultError } from './errors.js';
import type { CipherBlock, KeySlot, Note, VaultEnvelope, VaultHeader } from './types.js';

export const MAX_VAULT_BYTES = 16 * 1024 * 1024;

/** 检查不可信 JSON 的对象结构，喵~ */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultError('INVALID_FORMAT');
  return value as Record<string, unknown>;
}

/** 固定版本拒绝未定义字段，避免出现未经认证却被客户端解释的元数据，喵~ */
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new VaultError('INVALID_FORMAT');
}

/** 读取有长度边界的文本字段，喵~ */
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new VaultError('INVALID_FORMAT');
  return value;
}

/** 验证固定长度或有界的编码字节，喵~ */
function encoded(value: unknown, max: number, exact?: number): string {
  const result = string(value, Math.ceil(max * 4 / 3));
  const decoded = fromBase64(result, max);
  if (!decoded.length || (exact !== undefined && decoded.length !== exact)) throw new VaultError('INVALID_FORMAT');
  return result;
}

/** 验证 AES-GCM 密文块，喵~ */
function block(value: unknown, wrapped = false): CipherBlock {
  const r = record(value);
  onlyKeys(r, ['iv', 'data']);
  const iv = encoded(r.iv, 12, 12);
  const data = encoded(r.data, wrapped ? 48 : MAX_VAULT_BYTES, wrapped ? 48 : undefined);
  if (fromBase64(data).length < 16) throw new VaultError('INVALID_FORMAT');
  return { iv, data };
}

/** 重建字段顺序固定的密钥槽，避免各客户端的 JSON 顺序影响 AAD，喵~ */
function slot(value: unknown): KeySlot {
  const r = record(value);
  onlyKeys(r, ['label', 'credentialId', 'publicKey', 'algorithm', 'prfInput', 'hkdfSalt', 'wrappedKey']);
  if (r.algorithm !== -7) throw new VaultError('UNSUPPORTED');
  return {
    label: string(r.label, 80), credentialId: encoded(r.credentialId, 1024),
    publicKey: encoded(r.publicKey, 1024), algorithm: -7,
    prfInput: encoded(r.prfInput, 32, 32), hkdfSalt: encoded(r.hkdfSalt, 32, 32),
    wrappedKey: block(r.wrappedKey, true),
  };
}

export class VaultCodec {
  /** 解析版本一文件并拒绝不受支持的结构和算法，喵~ */
  static parse(bytes: Uint8Array): VaultEnvelope {
    if (bytes.length > MAX_VAULT_BYTES) throw new VaultError('INVALID_FORMAT');
    let r: Record<string, unknown>;
    try { r = record(JSON.parse(text(bytes))); } catch (e) { if (e instanceof VaultError) throw e; throw new VaultError('INVALID_FORMAT'); }
    if (r.format !== 'secure-notes') throw new VaultError('INVALID_FORMAT');
    if (r.version !== 1) throw new VaultError('UNSUPPORTED_VERSION');
    onlyKeys(r, ['format', 'version', 'vaultId', 'rpId', 'keySlots', 'payload']);
    const vaultId = string(r.vaultId, 64); const rpId = string(r.rpId, 253);
    if (!/^[a-f0-9]{32}$/.test(vaultId) || !/^[a-z0-9.-]+$/.test(rpId) || !rpId.length) throw new VaultError('INVALID_FORMAT');
    if (!Array.isArray(r.keySlots) || !r.keySlots.length || r.keySlots.length > 8) throw new VaultError('INVALID_FORMAT');
    const keySlots = r.keySlots.map(slot);
    if (new Set(keySlots.map(s => s.credentialId)).size !== keySlots.length) throw new VaultError('INVALID_FORMAT');
    return { format: 'secure-notes', version: 1, vaultId, rpId, keySlots, payload: block(r.payload) };
  }

  /** 序列化自包含密文文件，不接受明文笔记或连接凭据，喵~ */
  static serialize(envelope: VaultEnvelope): Uint8Array {
    const bytes = utf8(JSON.stringify(envelope));
    if (bytes.length > MAX_VAULT_BYTES) throw new VaultError('INVALID_INPUT');
    return bytes;
  }

  /** 构造覆盖整个公开头部的固定顺序 AAD，喵~ */
  static header(envelope: VaultHeader): Uint8Array {
    return utf8(JSON.stringify({ format: envelope.format, version: envelope.version, vaultId: envelope.vaultId, rpId: envelope.rpId, keySlots: envelope.keySlots }));
  }

  /** 校验解密后的笔记数据，拒绝重复标识与异常大小，喵~ */
  static notes(bytes: Uint8Array): Note[] {
    try {
      const value = record(JSON.parse(text(bytes)));
      onlyKeys(value, ['notes']);
      if (!Array.isArray(value.notes) || value.notes.length > 10_000) throw new VaultError('INVALID_FORMAT');
      const notes = value.notes.map(value => {
        const r = record(value);
        onlyKeys(r, ['id', 'title', 'body', 'createdAt', 'updatedAt']);
        const note: Note = { id: string(r.id, 64), title: string(r.title, 200), body: string(r.body, 1024 * 1024), createdAt: string(r.createdAt, 30), updatedAt: string(r.updatedAt, 30) };
        if (!note.id || !Number.isFinite(Date.parse(note.createdAt)) || !Number.isFinite(Date.parse(note.updatedAt))) throw new VaultError('INVALID_FORMAT');
        return note;
      });
      if (new Set(notes.map(n => n.id)).size !== notes.length) throw new VaultError('INVALID_FORMAT');
      return notes;
    } catch (e) { if (e instanceof VaultError) throw e; throw new VaultError('INVALID_FORMAT'); }
  }
}
