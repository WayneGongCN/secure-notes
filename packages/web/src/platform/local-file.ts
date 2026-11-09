import { MAX_VAULT_BYTES, VaultError, toBase64 } from '@secure-notes/core';
import type { StoredVault, VaultStore } from '@secure-notes/core';

export interface LocalHandle {
  name: string;
  /** 获取当前文件内容，不使用浏览器持久存储充当原文件，喵~ */
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** 创建可中止的临时写入，close 成功后才替换原文件，喵~ */
  createWritable(options?: { mode: 'exclusive' }): Promise<{ write(bytes: ArrayBuffer): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
  /** 在解锁前申请读写权限，拒绝后保留只读打开和导出能力，喵~ */
  requestPermission?(options: { mode: 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

interface PickerWindow {
  showOpenFilePicker?: (options: unknown) => Promise<LocalHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<LocalHandle>;
}

/** 将浏览器文件异常转换为稳定且不包含路径的错误码，喵~ */
function fileError(error: unknown): VaultError {
  if (error instanceof VaultError) return error;
  const name = (error as { name?: string })?.name;
  return new VaultError(name === 'AbortError' ? 'CANCELLED' : name === 'NotAllowedError' ? 'PERMISSION_DENIED' : name === 'NotFoundError' ? 'NOT_FOUND' : name === 'NoModificationAllowedError' ? 'CONFLICT' : 'SAVE_FAILED');
}

/** 用内容哈希检查本地文件变化，不声称它是跨进程原子锁，喵~ */
async function revision(bytes: Uint8Array): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)));
}

export class LocalFileStore implements VaultStore {
  readonly conditionalWrite: 'best-effort' | 'none';
  /** 接收用户明确授权的句柄，权限不写入浏览器持久存储，喵~ */
  constructor(readonly handle: LocalHandle, writable = true) { this.conditionalWrite = writable ? 'best-effort' : 'none'; }

  /** 读取同一文件的内容哈希及密文，喵~ */
  async read(): Promise<StoredVault> {
    try {
      const file = await this.handle.getFile(); if (!file.size) throw new VaultError('NOT_FOUND');
      if (file.size > MAX_VAULT_BYTES) throw new VaultError('INVALID_FORMAT');
      const bytes = new Uint8Array(await file.arrayBuffer()); return { bytes, revision: await revision(bytes) };
    } catch (e) { throw fileError(e); }
  }

  /** 检查外部修改后写入密文，失败则中止临时文件，喵~ */
  async write(bytes: Uint8Array, expectedRevision: string | null): Promise<{ revision: string }> {
    if (this.conditionalWrite === 'none') throw new VaultError('READ_ONLY');
    let writer: Awaited<ReturnType<LocalHandle['createWritable']>> | undefined;
    try {
      let current: StoredVault | undefined;
      try { current = await this.read(); } catch (e) { if (!(e instanceof VaultError) || e.code !== 'NOT_FOUND') throw e; }
      if (expectedRevision === null ? !!current : !current || current.revision !== expectedRevision) throw new VaultError('CONFLICT');
      writer = await this.handle.createWritable({ mode: 'exclusive' });
      await writer.write(bytes.slice().buffer as ArrayBuffer); await writer.close();
      return { revision: await revision(bytes) };
    } catch (e) { try { await writer?.abort?.(); } catch { /* 保留原始保存错误，喵~ */ } throw fileError(e); }
  }
}

export class ExportOnlyStore implements VaultStore {
  readonly conditionalWrite = 'none' as const;
  /** 保留当前页面内的文件副本以支持只读打开和手动导出，喵~ */
  constructor(readonly bytes: Uint8Array) {}
  /** 返回密文副本，不持久化笔记到浏览器，喵~ */
  async read(): Promise<StoredVault> { return { bytes: this.bytes.slice() }; }
  /** 明确拒绝不受支持的原地写回，喵~ */
  async write(): Promise<{ revision: string }> { throw new VaultError('READ_ONLY'); }
}

/** 打开用户选择的本地文件；不支持时交由 input 文件选择器处理，喵~ */
export async function openLocal(): Promise<LocalFileStore | undefined> {
  const picker = (window as unknown as PickerWindow).showOpenFilePicker;
  if (!picker) return undefined;
  try {
    const handles = await picker.call(window, { multiple: false, types: [{ description: 'Secure Notes 加密库', accept: { 'application/octet-stream': ['.snote'] } }] });
    if (!handles[0]) throw new VaultError('CANCELLED');
    const permission = await handles[0].requestPermission?.({ mode: 'readwrite' });
    return new LocalFileStore(handles[0], permission === undefined || permission === 'granted');
  } catch (e) { throw fileError(e); }
}

/** 为新库申请保存位置，必须在明确用户操作中调用，喵~ */
export async function newLocal(): Promise<LocalFileStore | undefined> {
  const picker = (window as unknown as PickerWindow).showSaveFilePicker;
  if (!picker) return undefined;
  try { return new LocalFileStore(await picker.call(window, { suggestedName: 'Notes.snote', types: [{ description: 'Secure Notes 加密库', accept: { 'application/octet-stream': ['.snote'] } }] })); }
  catch (e) { throw fileError(e); }
}

/** 只导出已封存密文，下载动作不代表同步或替换原文件成功，喵~ */
export function downloadVault(bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'Notes.snote'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
