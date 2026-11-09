import { describe, expect, it } from 'vitest';
import { LocalFileStore, ExportOnlyStore } from '../src/platform/local-file';
import type { LocalHandle } from '../src/platform/local-file';
import { VaultPersistence } from '@secure-notes/core';

/** 模拟仅在 close 成功时替换文件的浏览器句柄，喵~ */
function handle() {
  let bytes = new Uint8Array(); let fail = false;
  const file: LocalHandle = {
    name: 'Notes.snote',
    /** 返回当前文件快照，喵~ */
    async getFile() { return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }; },
    /** 模拟临时写入、提交与中止，喵~ */
    async createWritable() {
      let draft: Uint8Array;
      return { write: async next => { draft = new Uint8Array(next); }, close: async () => { if (fail) throw new Error('disk full'); bytes = draft; }, abort: async () => undefined };
    },
  };
  return { file, overwrite: (next: Uint8Array) => { bytes = next; }, fail: () => { fail = true; } };
}

describe('本地文件契约', () => {
  it('新建、读取和更新；外部修改后拒绝覆盖', async () => {
    const h = handle(); const store = new LocalFileStore(h.file);
    const a = await store.write(new Uint8Array([1]), null); expect((await store.read()).revision).toBe(a.revision);
    await store.write(new Uint8Array([2]), a.revision); const b = await store.read();
    h.overwrite(new Uint8Array([3])); await expect(store.write(new Uint8Array([4]), b.revision!)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.read()).bytes).toEqual(new Uint8Array([3]));
  });
  it('提交失败时保留原文件，且新建不能覆盖已有文件', async () => {
    const h = handle(); const store = new LocalFileStore(h.file); const saved = await store.write(new Uint8Array([1]), null);
    await expect(store.write(new Uint8Array([2]), null)).rejects.toMatchObject({ code: 'CONFLICT' });
    h.fail(); await expect(store.write(new Uint8Array([2]), saved.revision)).rejects.toMatchObject({ code: 'SAVE_FAILED' });
    expect((await store.read()).bytes).toEqual(new Uint8Array([1]));
  });
  it('文件导出模式不伪造原地保存成功', async () => {
    const persistence = new VaultPersistence(new ExportOnlyStore(new Uint8Array([1]))); await persistence.open();
    await expect(persistence.save(new Uint8Array([2]))).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(persistence.state.status).toBe('read-only');
  });
  it('读写授权被拒绝时仍可读取和导出，但不能调用原地写回', async () => {
    const h = handle(); h.overwrite(new Uint8Array([1])); const store = new LocalFileStore(h.file, false);
    expect((await store.read()).bytes).toEqual(new Uint8Array([1]));
    await expect(store.write(new Uint8Array([2]), null)).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
});
