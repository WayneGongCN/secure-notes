import { equalBytes } from './bytes.js';
import { asVaultError, VaultError } from './errors.js';
import type { PersistenceState, StoredVault, VaultStore } from './types.js';

export class VaultPersistence {
  #revision?: string;
  #exists = false;
  #initialized = false;
  #edit = 0;
  #last?: Uint8Array;
  #queue: Promise<unknown> = Promise.resolve();
  #state: PersistenceState = { status: 'idle' };
  #listeners = new Set<(state: PersistenceState) => void>();

  /** 绑定一个活动保存位置，不建立隐式的多后端复制，喵~ */
  constructor(readonly store: VaultStore) {}

  /** 返回保存状态副本，不携带连接配置与凭据，喵~ */
  get state(): PersistenceState { return { ...this.#state }; }

  /** 订阅保存状态；返回的回调解除订阅，喵~ */
  subscribe(listener: (state: PersistenceState) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }

  /** 发布独立于解锁状态的保存结果，喵~ */
  #set(state: PersistenceState): void {
    this.#state = state;
    for (const listener of this.#listeners) { try { listener(this.state); } catch { /* 展示异常不影响条件写入，喵~ */ } }
  }

  /** 记录新编辑，避免较早上传的成功响应覆盖最新未保存状态，喵~ */
  markDirty(): void {
    this.#edit++;
    if (this.#state.status !== 'conflict') this.#set({ status: this.#writable() ? 'dirty' : 'read-only' });
  }

  /** 读取内容与版本，缺失版本的已有远端只能读取与导出，喵~ */
  async open(): Promise<StoredVault> {
    await this.#queue.catch(() => undefined);
    const result = await this.store.read();
    this.#exists = true; this.#initialized = true; this.#revision = result.revision; this.#last = result.bytes.slice();
    this.#set({ status: this.#writable() ? 'saved' : 'read-only' }); return result;
  }

  /** 显式创建新文件，底层必须以不存在条件防止覆盖，喵~ */
  async create(bytes: Uint8Array): Promise<void> {
    if (this.#exists || this.#state.status === 'saving') throw new VaultError('CONFLICT');
    this.#initialized = true; this.#exists = false; this.#revision = undefined;
    await this.save(bytes);
  }

  /** 判断是否具备当前内容所需的版本保护，喵~ */
  #writable(): boolean { return this.store.conditionalWrite !== 'none' && (!this.#exists || !!this.#revision); }

  /** 串行保存加密快照，任何冲突发生后停止后续覆盖，喵~ */
  save(bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice(); const edit = this.#edit;
    const operation = async (): Promise<void> => {
      if (!this.#initialized) throw new VaultError('INVALID_INPUT');
      if (this.#state.status === 'conflict') throw new VaultError('CONFLICT');
      if (!this.#writable()) { this.#set({ status: 'read-only', code: 'READ_ONLY' }); throw new VaultError('READ_ONLY'); }
      if (this.#last && equalBytes(this.#last, copy)) { this.#set({ status: edit === this.#edit ? 'saved' : 'dirty' }); return; }
      this.#set({ status: 'saving' });
      try {
        let revision: string;
        try { revision = (await this.store.write(copy, this.#exists ? this.#revision! : null)).revision; }
        catch (e) {
          const error = asVaultError(e);
          if (!['NETWORK', 'TIMEOUT', 'SAVE_FAILED'].includes(error.code)) throw error;
          let current: StoredVault;
          try { current = await this.store.read(); } catch { throw error; }
          if (!equalBytes(copy, current.bytes)) throw new VaultError('CONFLICT');
          if (!current.revision) throw new VaultError('SAVE_FAILED');
          revision = current.revision;
        }
        if (!revision) throw new VaultError('SAVE_FAILED');
        this.#exists = true; this.#revision = revision; this.#last = copy;
        this.#set({ status: edit === this.#edit ? 'saved' : 'dirty' });
      } catch (e) {
        const error = asVaultError(e);
        this.#set({ status: error.code === 'CONFLICT' ? 'conflict' : error.code === 'READ_ONLY' ? 'read-only' : 'error', code: error.code });
        throw error;
      }
    };
    const queued = this.#queue.then(operation, operation); this.#queue = queued; return queued;
  }
}
