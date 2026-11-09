import { describe, expect, it } from 'vitest';
import { VaultPersistence } from '../src/persistence.js';
import type { VaultStore } from '../src/types.js';
import { MemoryStore } from './helpers.js';

describe('条件写入与会话无关的保存流程', () => {
  it('两台设备同时编辑时，后保存者不能覆盖已提交版本', async () => {
    const store = new MemoryStore(); const create = new VaultPersistence(store); await create.create(new Uint8Array([1]));
    const a = new VaultPersistence(store); const b = new VaultPersistence(store); await a.open(); await b.open();
    a.markDirty(); await a.save(new Uint8Array([2])); b.markDirty();
    await expect(b.save(new Uint8Array([3]))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(b.save(new Uint8Array([4]))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.read()).bytes).toEqual(new Uint8Array([2]));
  });

  it('新建使用不存在条件，不能覆盖已存在文件', async () => {
    const store = new MemoryStore(); await new VaultPersistence(store).create(new Uint8Array([1]));
    await expect(new VaultPersistence(store).create(new Uint8Array([2]))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.writes).toBe(1);
  });

  it('服务器已提交但响应丢失时回读确认，不盲目重试上传', async () => {
    const store = new MemoryStore(); const persistence = new VaultPersistence(store); store.loseResponse = true;
    await persistence.create(new Uint8Array([1])); expect(persistence.state.status).toBe('saved');
    expect(store.writes).toBe(1); await persistence.save(new Uint8Array([2])); expect(store.writes).toBe(2);
  });

  it('已有文件缺少版本时不会使用 null 退化为创建操作', async () => {
    let writes = 0;
    const store: VaultStore = { conditionalWrite: 'atomic', read: async () => ({ bytes: new Uint8Array([1]) }), write: async () => { writes++; return { revision: 'bad' }; } };
    const persistence = new VaultPersistence(store); await persistence.open();
    await expect(persistence.save(new Uint8Array([2]))).rejects.toMatchObject({ code: 'READ_ONLY' }); expect(writes).toBe(0);
  });

  it('较早保存的成功不能把较新的未提交编辑标记为已保存', async () => {
    const store = new MemoryStore(); const persistence = new VaultPersistence(store); await persistence.create(new Uint8Array([1]));
    let release!: () => void; const original = store.write.bind(store);
    store.write = async (bytes, expected) => { await new Promise<void>(resolve => { release = resolve; }); return original(bytes, expected); };
    persistence.markDirty(); const saving = persistence.save(new Uint8Array([2]));
    await Promise.resolve(); persistence.markDirty(); release(); await saving;
    expect(persistence.state.status).toBe('dirty');
  });
});
