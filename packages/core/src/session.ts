import { fromBase64, toBase64 } from './bytes.js';
import { VaultCodec } from './codec.js';
import { VaultCrypto } from './crypto.js';
import { asVaultError, VaultError } from './errors.js';
import type { CryptoKeyHandle, CryptoRuntime, HardwareCredential, HardwareKeyProvider, Note, SessionState, SessionStatus, VaultEnvelope, VaultHeader } from './types.js';

export interface SessionOptions {
  crypto: CryptoRuntime;
  hardware: HardwareKeyProvider;
  rpId: string;
  idleTimeoutMs?: number;
  /** 返回单调递增的毫秒时间，供所有业务入口检查空闲期限，喵~ */
  now?: () => number;
}

export class VaultSession {
  readonly #crypto: VaultCrypto;
  readonly #hardware: HardwareKeyProvider;
  readonly #rpId: string;
  readonly #now: () => number;
  #idle: number;
  #lastActivity = 0;
  #status: SessionStatus = 'empty';
  #header?: VaultHeader;
  #latest?: VaultEnvelope;
  #raw?: Uint8Array;
  #key?: CryptoKeyHandle;
  #notes: Note[] = [];
  #epoch = 0;
  #document = 0;
  #contentVersion = 0;
  #snapshotVersion = 0;
  #pending = new Set<Promise<void>>();
  #controller?: AbortController;
  #lockReason?: string;
  #listeners = new Set<(state: SessionState) => void>();

  /** 只注入密码学、硬件与时钟，不读取任何平台环境，喵~ */
  constructor(options: SessionOptions) {
    if (!/^[a-z0-9.-]+$/.test(options.rpId)) throw new VaultError('INVALID_INPUT');
    this.#crypto = new VaultCrypto(options.crypto); this.#hardware = options.hardware;
    this.#rpId = options.rpId; this.#now = options.now ?? (() => performance.now());
    this.#idle = options.idleTimeoutMs ?? 60_000;
  }

  /** 提供不包含笔记、密钥及 PRF 输出的状态副本，喵~ */
  get state(): SessionState {
    return { status: this.#status, vaultId: this.#header?.vaultId, keyLabels: this.#header?.keySlots.map(s => s.label) ?? [], contentVersion: this.#contentVersion, snapshotVersion: this.#snapshotVersion, canPersist: (this.#latest?.keySlots.length ?? 0) >= 1, lockReason: this.#lockReason };
  }

  /** 订阅无敏感信息的状态；返回的回调解除订阅，喵~ */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }

  /** 隔离监听者异常，确保外部界面不能中断密钥清理，喵~ */
  #emit(): void { for (const listener of this.#listeners) { try { listener(this.state); } catch { /* 监听异常不改变安全状态，喵~ */ } } }

  /** 失效所有旧认证任务并清理可控明文和原始密钥，喵~ */
  lock(reason = 'manual'): void {
    this.#epoch++; this.#controller?.abort(); this.#controller = undefined;
    this.#raw?.fill(0); this.#raw = undefined; this.#key = undefined; this.#notes = [];
    this.#status = this.#latest ? 'locked' : 'empty'; this.#lockReason = reason; this.#emit();
  }

  /** 打开新的密文文档，同时使旧文档的所有异步结果失效，喵~ */
  load(bytes: Uint8Array): void {
    const envelope = VaultCodec.parse(bytes);
    if (envelope.rpId !== this.#rpId) throw new VaultError('RP_MISMATCH');
    this.lock('load'); this.#document++; this.#pending.clear();
    this.#header = envelope; this.#latest = envelope;
    this.#contentVersion = 0; this.#snapshotVersion = 0; this.#status = 'locked'; this.#emit();
  }

  /** 显式关闭当前库，并隔离仍在执行的旧文档封存任务，喵~ */
  reset(): void {
    this.lock('close'); this.#document++; this.#pending.clear(); this.#header = undefined; this.#latest = undefined;
    this.#contentVersion = 0; this.#snapshotVersion = 0; this.#status = 'empty'; this.#emit();
  }

  /** 为当前库返回公开凭据选择信息，喵~ */
  credentials(): ReadonlyArray<{ id: string; label: string }> {
    return this.#header?.keySlots.map(s => ({ id: s.credentialId, label: s.label })) ?? [];
  }

  /** 启动有时限的认证，认证期间不提供笔记访问，喵~ */
  #beginAuth(): { epoch: number; signal: AbortSignal } {
    if (this.#status === 'authenticating') throw new VaultError('INVALID_INPUT');
    this.#controller?.abort(); this.#controller = new AbortController(); this.#epoch++;
    this.#status = 'authenticating'; this.#lockReason = undefined; this.#emit();
    return { epoch: this.#epoch, signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(90_000)]) };
  }

  /** 确认异步结果仍属于当前有效的认证或编辑会话，喵~ */
  #assertEpoch(epoch: number): void { if (epoch !== this.#epoch) throw new VaultError('STALE_OPERATION'); }

  /** 完成认证后发布解锁状态，不允许旧任务调用，喵~ */
  #activate(epoch: number): void {
    this.#assertEpoch(epoch); this.#status = 'unlocked'; this.#lastActivity = this.#now(); this.#lockReason = undefined; this.#emit();
  }

  /** 统一处理认证失败，旧任务不能锁定已经建立的新会话，喵~ */
  #authFailure(epoch: number, error: unknown): never {
    if (epoch === this.#epoch) this.lock('authentication-failed');
    throw asVaultError(error, 'AUTH_FAILED');
  }

  /** 单独登记硬件，便于客户端为每一次浏览器认证提供显式用户操作，喵~ */
  async enroll(label: string): Promise<HardwareCredential> {
    if (!label.trim() || label.length > 80) throw new VaultError('INVALID_INPUT');
    const wasUnlocked = this.#status === 'unlocked';
    if (wasUnlocked) this.#requireUnlocked();
    const auth = this.#beginAuth();
    try {
      const credential = await this.#hardware.enroll({ rpId: this.#rpId, userId: this.#crypto.random(32), label, signal: auth.signal });
      this.#assertEpoch(auth.epoch);
      if (credential.algorithm !== -7 || !credential.credentialId.length || !credential.publicKey.length) throw new VaultError('UNSUPPORTED');
      if (wasUnlocked) this.#activate(auth.epoch);
      else { this.#status = this.#latest ? 'locked' : 'empty'; this.#emit(); }
      return credential;
    } catch (e) { return this.#authFailure(auth.epoch, e); }
  }

  /** 验证主硬件并封存新库，完成后即可保存，备用槽可按需添加，喵~ */
  async create(primary: HardwareCredential, label = '主密钥'): Promise<void> {
    if (this.#latest) throw new VaultError('INVALID_INPUT');
    const auth = this.#beginAuth(); const raw = this.#crypto.random(32); let committed = false; let secret: Uint8Array | undefined;
    try {
      const prfInput = this.#crypto.random(32);
      secret = await this.#hardware.deriveSecret({ rpId: this.#rpId, credential: primary, prfInput, signal: auth.signal });
      this.#assertEpoch(auth.epoch);
      const base = { format: 'secure-notes' as const, version: 1 as const, vaultId: this.#crypto.id(), rpId: this.#rpId };
      const slot = await this.#crypto.wrap(raw, secret, base, primary, label, prfInput);
      const header = { ...base, keySlots: [slot] }; const key = await this.#crypto.importKey(raw);
      const latest = await this.#crypto.seal(header, key, []); this.#assertEpoch(auth.epoch);
      this.#document++; this.#header = header; this.#latest = latest; this.#key = key; this.#raw = raw; committed = true;
      this.#notes = []; this.#contentVersion = 1; this.#snapshotVersion = 1; this.#activate(auth.epoch);
    } catch (e) { this.#authFailure(auth.epoch, e); }
    finally { secret?.fill(0); if (!committed) raw.fill(0); }
  }

  /** 为当前库增加独立硬件包装槽，成功前不会替换已有密文，喵~ */
  async addKey(credential: HardwareCredential, label = '备用密钥'): Promise<void> {
    this.#requireUnlocked();
    const header = this.#header!; const key = this.#key!;
    if (header.keySlots.length >= 8 || header.keySlots.some(s => s.credentialId === toBase64(credential.credentialId))) throw new VaultError('INVALID_INPUT');
    const raw = this.#raw!.slice(); const notes = this.#notes.map(n => ({ ...n })); const auth = this.#beginAuth(); let secret: Uint8Array | undefined;
    try {
      const prfInput = this.#crypto.random(32);
      secret = await this.#hardware.deriveSecret({ rpId: this.#rpId, credential, prfInput, signal: auth.signal }); this.#assertEpoch(auth.epoch);
      const slot = await this.#crypto.wrap(raw, secret, header, credential, label, prfInput);
      const next = { ...header, keySlots: [...header.keySlots, slot] };
      const latest = await this.#crypto.seal(next, key, notes); VaultCodec.serialize(latest); this.#assertEpoch(auth.epoch);
      this.#document++; this.#header = next; this.#latest = latest; this.#contentVersion++; this.#snapshotVersion = this.#contentVersion;
      this.#activate(auth.epoch);
    } catch (e) { this.#authFailure(auth.epoch, e); }
    finally { raw.fill(0); secret?.fill(0); notes.length = 0; }
  }

  /** 使用指定主或备用硬件独立解锁，失败时不保留部分明文，喵~ */
  async unlock(credentialId?: string): Promise<void> {
    if (!this.#latest || !this.#header) throw new VaultError('INVALID_INPUT');
    if (this.#status === 'unlocked') this.lock('reauthenticate');
    const slot = credentialId ? this.#header.keySlots.find(s => s.credentialId === credentialId) : this.#header.keySlots[0];
    if (!slot) throw new VaultError('WRONG_KEY');
    const auth = this.#beginAuth(); let raw: Uint8Array | undefined; let secret: Uint8Array | undefined; let committed = false;
    try {
      await Promise.all([...this.#pending]); this.#assertEpoch(auth.epoch);
      const envelope = this.#latest!;
      secret = await this.#hardware.deriveSecret({ rpId: this.#rpId, credential: { credentialId: fromBase64(slot.credentialId), publicKey: fromBase64(slot.publicKey), algorithm: slot.algorithm }, prfInput: fromBase64(slot.prfInput), signal: auth.signal });
      this.#assertEpoch(auth.epoch); raw = await this.#crypto.unwrap(secret, envelope, slot);
      const key = await this.#crypto.importKey(raw); const notes = await this.#crypto.open(envelope, key); this.#assertEpoch(auth.epoch);
      this.#raw = raw; this.#key = key; this.#notes = notes; committed = true; this.#activate(auth.epoch);
    } catch (e) { this.#authFailure(auth.epoch, e); }
    finally { secret?.fill(0); if (!committed) raw?.fill(0); }
  }

  /** 接收客户端报告的真实用户活动，不通过渲染或保存自动延长会话，喵~ */
  touch(): void { if (this.#status === 'unlocked') { this.checkIdle(); if (this.#status === 'unlocked') this.#lastActivity = this.#now(); } }

  /** 在任何受保护操作之前以及客户端计时器中检查空闲期限，喵~ */
  checkIdle(): void { if (this.#status === 'unlocked' && this.#now() - this.#lastActivity >= this.#idle) this.lock('idle'); }

  /** 更新空闲时长并立即执行已有期限检查，喵~ */
  setIdleTimeout(ms: number): void {
    if (![30_000, 60_000, 300_000].includes(ms)) throw new VaultError('INVALID_INPUT');
    this.#idle = ms; this.checkIdle();
  }

  /** 守卫所有明文入口，阻止过期会话和认证中的读写，喵~ */
  #requireUnlocked(): void { this.checkIdle(); if (this.#status !== 'unlocked' || !this.#key || !this.#raw) throw new VaultError('LOCKED'); }

  /** 返回明文笔记副本，避免外部修改绕过封存与校验，喵~ */
  listNotes(): Note[] { this.#requireUnlocked(); return this.#notes.map(n => ({ ...n })); }

  /** 新增笔记并等待对应密文快照完成，喵~ */
  async addNote(title = '', body = ''): Promise<Note> {
    this.#requireUnlocked(); this.#validateText(title, body);
    if (this.#notes.length >= 10_000) throw new VaultError('INVALID_INPUT');
    const now = new Date().toISOString(); const note: Note = { id: this.#crypto.id(), title, body, createdAt: now, updatedAt: now };
    this.#notes = [note, ...this.#notes]; const epoch = this.#epoch;
    await this.#sealChange(); this.#assertEpoch(epoch); return { ...note };
  }

  /** 更新笔记正文与时间，明文校验完成后立即启动加密，喵~ */
  async updateNote(id: string, input: Pick<Note, 'title' | 'body'>): Promise<void> {
    this.#requireUnlocked(); this.#validateText(input.title, input.body);
    const index = this.#notes.findIndex(n => n.id === id); if (index < 0) throw new VaultError('NOT_FOUND');
    this.#notes[index] = { ...this.#notes[index]!, ...input, updatedAt: new Date().toISOString() };
    const epoch = this.#epoch; await this.#sealChange(); this.#assertEpoch(epoch);
  }

  /** 删除当前版本中的笔记并封存，历史备份由存储策略独立管理，喵~ */
  async deleteNote(id: string): Promise<void> {
    this.#requireUnlocked(); if (!this.#notes.some(n => n.id === id)) throw new VaultError('NOT_FOUND');
    this.#notes = this.#notes.filter(n => n.id !== id); const epoch = this.#epoch;
    await this.#sealChange(); this.#assertEpoch(epoch);
  }

  /** 限制单篇笔记大小，保证整个文件可在受控内存中封存，喵~ */
  #validateText(title: string, body: string): void {
    if (typeof title !== 'string' || typeof body !== 'string' || title.length > 200 || body.length > 1024 * 1024) throw new VaultError('INVALID_INPUT');
  }

  /** 异步加密可在锁定后完成，但只能发布同一文档最新版本的密文，喵~ */
  async #sealChange(): Promise<void> {
    const version = ++this.#contentVersion; const document = this.#document;
    const notes = this.#notes.map(n => ({ ...n })); const header = this.#header!; const key = this.#key!;
    this.#emit();
    const work = this.#crypto.seal(header, key, notes).then(envelope => {
      VaultCodec.serialize(envelope);
      if (document === this.#document && version > this.#snapshotVersion) { this.#latest = envelope; this.#snapshotVersion = version; this.#emit(); }
    }).finally(() => { notes.length = 0; this.#pending.delete(work); });
    this.#pending.add(work); await work;
  }

  /** 导出已封存且至少绑定一把已验证硬件的密文，喵~ */
  async snapshot(): Promise<Uint8Array> {
    await Promise.all([...this.#pending]);
    if (!this.#latest || this.#latest.keySlots.length < 1) throw new VaultError('INVALID_INPUT');
    if (this.#snapshotVersion < this.#contentVersion) throw new VaultError('SAVE_FAILED');
    return VaultCodec.serialize(this.#latest);
  }
}
