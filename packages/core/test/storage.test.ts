import { describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Store } from '../src/storage/s3.js';
import type { S3Transport } from '../src/storage/s3.js';
import { WebDavStore } from '../src/storage/webdav.js';
import { VaultPersistence } from '../src/persistence.js';
import { VaultError } from '../src/errors.js';
import type { VaultStore } from '../src/types.js';

/** 创建同一个对象的原子存储服务替身，喵~ */
function backend() {
  let bytes: Uint8Array | undefined; let version = 0; let weak = false; let omitPutTag = false;
  const requests: Array<{ method: string; headers: Record<string, string> }> = [];
  /** 执行服务端条件判断，两个客户端共享此状态，喵~ */
  function put(next: Uint8Array, match?: string, none?: string): void {
    if (none === '*' ? !!bytes : !bytes || match !== `"${version}"`) throw new VaultError('CONFLICT');
    bytes = next.slice(); version++;
  }
  const fetcher: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers); const method = init?.method ?? 'GET';
    requests.push({ method, headers: Object.fromEntries(headers) });
    if (method === 'PUT') {
      try { put(new Uint8Array(init?.body as ArrayBuffer), headers.get('If-Match') ?? undefined, headers.get('If-None-Match') ?? undefined); }
      catch { return new Response(null, { status: 412 }); }
      return new Response(null, { status: 204, headers: omitPutTag ? {} : { ETag: `"${version}"` } });
    }
    return bytes ? new Response(bytes.slice().buffer as ArrayBuffer, { headers: { ETag: weak ? `W/"${version}"` : `"${version}"` } }) : new Response(null, { status: 404 });
  };
  const transport: S3Transport = {
    /** 模拟 SDK 的对象请求及响应流，不加载任何云端凭据，喵~ */
    async send(command) {
      if (command instanceof PutObjectCommand) {
        try { put(command.input.Body as Uint8Array, command.input.IfMatch, command.input.IfNoneMatch); }
        catch { throw { $metadata: { httpStatusCode: 412 } }; }
        requests.push({ method: 'PUT', headers: { 'if-match': command.input.IfMatch ?? '', 'if-none-match': command.input.IfNoneMatch ?? '' } });
        return { $metadata: {}, ETag: omitPutTag ? undefined : `"${version}"` };
      }
      if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
      if (!bytes) throw { $metadata: { httpStatusCode: 404 } };
      const copy = bytes.slice();
      return { $metadata: {}, ETag: weak ? `W/"${version}"` : `"${version}"`, Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close(); } }) } } as never;
    },
  };
  return { fetcher, transport, requests, weak: () => { weak = true; }, omitPutTag: () => { omitPutTag = true; } };
}

/** 使用仅供测试的显式凭据构建 S3 客户端，喵~ */
function s3(service: ReturnType<typeof backend>, verified = true): S3Store {
  return new S3Store({ endpoint: 'https://storage.invalid', region: 'test', bucket: 'notes', key: 'Notes.snote', credentials: { accessKeyId: 'TEST_ONLY', secretAccessKey: 'TEST_ONLY' }, transport: service.transport, conditionalWritesVerified: verified });
}

/** 使用内存服务构建 WebDAV 客户端，喵~ */
function dav(service: ReturnType<typeof backend>, verified = true): WebDavStore {
  return new WebDavStore({ url: 'https://storage.invalid/Notes.snote', username: 'test', password: 'TEST_ONLY', fetch: service.fetcher, conditionalWritesVerified: verified });
}

describe.each([['S3', s3], ['WebDAV', dav]] as const)('%s 统一存储契约', (_name, factory) => {
  it('新建、读取、条件更新，并拒绝第二台设备的旧版本', async () => {
    const service = backend(); const store: VaultStore = factory(service);
    await expect(store.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const created = await store.write(new Uint8Array([1]), null); expect(created.revision).toBe('"1"');
    const a = await store.read(); const b = await factory(service).read();
    await store.write(new Uint8Array([2]), a.revision!);
    await expect(factory(service).write(new Uint8Array([3]), b.revision!)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.read()).bytes).toEqual(new Uint8Array([2]));
    await expect(store.write(new Uint8Array([4]), null)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(service.requests.find(r => r.method === 'PUT')?.headers['if-none-match']).toBe('*');
  });

  it('未确认服务器条件写入能力时默认只读', async () => {
    const service = backend(); const store = factory(service, false);
    expect(store.conditionalWrite).toBe('none');
    await expect(store.write(new Uint8Array([1]), null)).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(service.requests).toHaveLength(0);
  });

  it('弱 ETag 不被错误用于条件更新', async () => {
    const service = backend(); const store = factory(service); await store.write(new Uint8Array([1]), null); service.weak();
    const persistence = new VaultPersistence(store); const result = await persistence.open(); expect(result.revision).toBeUndefined();
    await expect(persistence.save(new Uint8Array([2]))).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(store.write(new Uint8Array([2]), 'W/"1"')).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  it('PUT 成功却不暴露 ETag 时，回读相同内容才确认成功', async () => {
    const service = backend(); service.omitPutTag(); const persistence = new VaultPersistence(factory(service));
    await persistence.create(new Uint8Array([1])); expect(persistence.state.status).toBe('saved');
  });
});

describe('端点及错误保护', () => {
  it('拒绝明文 HTTP 和内嵌凭据地址', () => {
    for (const url of ['http://storage.invalid/note', 'https://secret:password@storage.invalid/note']) {
      expect(() => new WebDavStore({ url, username: 'test', password: 'test' })).toThrow('INVALID_INPUT');
    }
  });
  it.each([[401, 'AUTH_FAILED'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [412, 'CONFLICT']] as const)('HTTP %i 映射为 %s', async (status, code) => {
    const store = new WebDavStore({ url: 'https://storage.invalid/file', username: 'test', password: 'secret', fetch: async () => new Response(null, { status }) });
    await expect(store.read()).rejects.toMatchObject({ code });
  });
  it('跨域或网络异常不暴露底层异常中的凭据', async () => {
    const store = new WebDavStore({ url: 'https://storage.invalid/file', username: 'test', password: 'secret', fetch: async () => { throw new Error('secret request'); } });
    try { await store.read(); } catch (error) { expect((error as Error).message).toBe('NETWORK'); expect((error as Error).cause).toBeUndefined(); }
  });
  it('S3 临时凭据过期是认证错误而非静默保存失败', async () => {
    const service = backend(); service.transport.send = async () => { throw { name: 'ExpiredToken', message: 'secret request' }; };
    await expect(s3(service).read()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
