import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { VaultSession } from '../src/session.js';
import { VaultCodec } from '../src/codec.js';
import { VaultCrypto, toCtapHmacSalt } from '../src/crypto.js';
import { fromBase64, toBase64, utf8 } from '../src/bytes.js';
import { fixture, runtime, TestHardware } from './helpers.js';

describe('无 DOM 的业务与真实密码学', () => {
  it('主备密钥各自独立打开同一个自包含文件', async () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    const { session, hardware, bytes } = await fixture(); const slots = session.credentials();
    expect(new TextDecoder().decode(bytes)).not.toContain('隐私标题');
    expect(new TextDecoder().decode(bytes)).not.toContain('中文正文');
    for (const slot of slots) {
      const restored = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
      restored.load(bytes); await restored.unlock(slot.id);
      expect(restored.listNotes()[0]?.body).toBe('绝不应出现在密文文件中的中文正文');
      restored.lock(); expect(() => restored.listNotes()).toThrow('LOCKED');
    }
  });

  it('新增编辑删除封存后可以完整往返', async () => {
    const { session, hardware } = await fixture();
    const note = await session.addNote('临时', '第一版');
    await session.updateNote(note.id, { title: '修改后', body: '第二版 🗝️\n第三行' });
    const restored = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
    restored.load(await session.snapshot()); await restored.unlock();
    expect(restored.listNotes().find(n => n.id === note.id)?.body).toBe('第二版 🗝️\n第三行');
    await restored.deleteNote(note.id); expect(restored.listNotes()).toHaveLength(1);
  });

  it('不向持有错误硬件或篡改过密文的调用方交付笔记', async () => {
    const { hardware, bytes } = await fixture();
    const wrong = new VaultSession({ crypto: runtime, hardware: new TestHardware(), rpId: 'notes.example' });
    wrong.load(bytes); await expect(wrong.unlock()).rejects.toMatchObject({ code: 'WRONG_KEY' });
    const envelope = VaultCodec.parse(bytes); const cipher = fromBase64(envelope.payload.data); cipher[0] = cipher[0]! ^ 1;
    envelope.payload.data = toBase64(cipher);
    const modified = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
    modified.load(VaultCodec.serialize(envelope)); await expect(modified.unlock()).rejects.toMatchObject({ code: 'TAMPERED' });
    expect(modified.state.status).toBe('locked');
  });

  it('公开密钥槽元数据同样经过认证', async () => {
    const { hardware, bytes } = await fixture(); const envelope = VaultCodec.parse(bytes);
    envelope.keySlots[1]!.label = '被替换的标签';
    const session = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
    session.load(VaultCodec.serialize(envelope)); await expect(session.unlock()).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('主硬件验证后即可持久化并恢复，尚未验证时不能导出', async () => {
    const hardware = new TestHardware(); const session = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
    const primary = await session.enroll('主密钥');
    expect(session.state.canPersist).toBe(false); await expect(session.snapshot()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await session.create(primary);
    expect(session.state.canPersist).toBe(true);
    await session.addNote('单密钥笔记', '仅用主密钥恢复'); session.lock();
    const bytes = await session.snapshot(); expect(VaultCodec.parse(bytes).keySlots).toHaveLength(1);
    const restored = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
    restored.load(bytes); await restored.unlock();
    expect(restored.listNotes()[0]?.body).toBe('仅用主密钥恢复');
  });

  it('不依赖计时器触发也能在业务入口执行空闲锁定', async () => {
    let now = 0; const { session } = await fixture(() => now);
    now = 59_999; expect(session.listNotes()).toHaveLength(1);
    now = 60_000; expect(() => session.listNotes()).toThrow('LOCKED');
    expect(session.state.lockReason).toBe('idle');
  });

  it('旧认证结果不能在锁定后重新激活会话', async () => {
    const { session, hardware } = await fixture(); session.lock();
    let finish!: () => void; hardware.beforeDerive = () => new Promise(resolve => { finish = resolve; });
    const opening = session.unlock(); await Promise.resolve(); session.lock('background'); finish();
    await expect(opening).rejects.toMatchObject({ code: 'STALE_OPERATION' });
    expect(session.state.status).toBe('locked'); expect(() => session.listNotes()).toThrow('LOCKED');
  });

  it('锁定前发起的加密可以完成并导出，但不能返回明文操作结果', async () => {
    const { session, hardware } = await fixture();
    const change = session.addNote('最后一笔', '待保存'); session.lock('blur');
    await expect(change).rejects.toMatchObject({ code: 'STALE_OPERATION' });
    const bytes = await session.snapshot(); const next = new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
    next.load(bytes); await next.unlock(); expect(next.listNotes()[0]?.title).toBe('最后一笔');
  });

  it('拒绝错误 RP、未知版本、重复凭据及异常编码', async () => {
    const { bytes, hardware } = await fixture();
    const other = new VaultSession({ crypto: runtime, hardware, rpId: 'other.example' });
    expect(() => other.load(bytes)).toThrow('RP_MISMATCH');
    const json = JSON.parse(new TextDecoder().decode(bytes)); json.version = 9;
    expect(() => VaultCodec.parse(utf8(JSON.stringify(json)))).toThrow('UNSUPPORTED_VERSION');
    json.version = 1; json.keySlots[1] = json.keySlots[0];
    expect(() => VaultCodec.parse(utf8(JSON.stringify(json)))).toThrow('INVALID_FORMAT');
    expect(() => fromBase64('AB')).toThrow('INVALID_FORMAT');
  });

  it('固定 CTAP 域分离向量，避免未来 CLI 重复或漏算前缀', async () => {
    const input = utf8('WebAuthn PRF test vectors\u0002');
    const actual = await toCtapHmacSalt(runtime, input);
    expect(Buffer.from(actual).toString('hex')).toBe('527413ebb48293772df30f031c5ac4650c7de14bf9498671ae163447b6a772b3');
    expect(Buffer.from(actual)).toEqual(createHash('sha256').update('WebAuthn PRF\0').update(input).digest());
  });

  it('拒绝未定义头部字段，且分块 base64 编码兼容标准实现', async () => {
    const { bytes } = await fixture(); const json = JSON.parse(new TextDecoder().decode(bytes)); json.unauthenticated = 'injected';
    expect(() => VaultCodec.parse(utf8(JSON.stringify(json)))).toThrow('INVALID_FORMAT');
    for (const size of [0, 1, 2, 3, 8191, 8192, 12000]) {
      const input = runtime.getRandomValues(new Uint8Array(size)); const encoded = toBase64(input);
      expect(encoded).toBe(Buffer.from(input).toString('base64url')); expect(fromBase64(encoded)).toEqual(input);
    }
  });

  it('使用新的随机 nonce，且包装后清理调用方 PRF 缓冲区', async () => {
    const crypto = new VaultCrypto(runtime); const raw = crypto.random(32); const key = await crypto.importKey(raw);
    const a = await crypto.encrypt(key, utf8('same'), utf8('context')); const b = await crypto.encrypt(key, utf8('same'), utf8('context'));
    expect(a.iv).not.toBe(b.iv); expect(a.data).not.toBe(b.data);
    const secret = crypto.random(32);
    await crypto.wrap(raw, secret, { vaultId: 'a'.repeat(32), rpId: 'notes.example' }, { credentialId: new Uint8Array([1]), publicKey: new Uint8Array([2]), algorithm: -7 }, '主密钥', crypto.random(32));
    expect(secret.every(b => b === 0)).toBe(true);
  });
});
