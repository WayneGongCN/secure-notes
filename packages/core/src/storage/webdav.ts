import { buffer, toBase64, utf8 } from '../bytes.js';
import { VaultError } from '../errors.js';
import type { StoredVault, VaultStore } from '../types.js';
import { httpsUrl, readStream, statusError, strongEtag } from './http.js';

export interface WebDavOptions {
  url: string;
  username: string;
  password: string;
  conditionalWritesVerified?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class WebDavStore implements VaultStore {
  readonly conditionalWrite: 'atomic' | 'none';
  readonly #url: string;
  readonly #authorization: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;

  /** 配置固定 WebDAV 文件地址和仅存于内存的应用凭据，喵~ */
  constructor(options: WebDavOptions) {
    this.#url = httpsUrl(options.url);
    if (!options.username || options.username.includes(':') || !options.password) throw new VaultError('INVALID_INPUT');
    const encoded = toBase64(utf8(`${options.username}:${options.password}`)).replaceAll('-', '+').replaceAll('_', '/');
    this.#authorization = `Basic ${encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')}`;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis); this.#timeout = options.timeoutMs ?? 15_000;
    this.conditionalWrite = options.conditionalWritesVerified ? 'atomic' : 'none';
  }

  /** 禁用缓存并限定请求时长，禁止隐式重定向到其他端点，喵~ */
  async #request(method: 'GET' | 'PUT', headers?: Record<string, string>, body?: Uint8Array): Promise<Response> {
    const signal = AbortSignal.timeout(this.#timeout);
    try {
      const init = { method, redirect: 'error' as const, cache: 'no-store' as const, credentials: 'omit' as const, signal,
        headers: { Authorization: this.#authorization, ...headers }, body: body ? buffer(body) : undefined };
      const response = await this.#fetch(this.#url, init);
      if (!response.ok) throw statusError(response.status);
      return response;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError(signal.aborted ? 'TIMEOUT' : 'NETWORK');
    }
  }

  /** 同一次 GET 获取密文和强 ETag，缺失 ETag 的文件仍可只读导出，喵~ */
  async read(): Promise<StoredVault> {
    const response = await this.#request('GET');
    if (!response.body) throw new VaultError('INVALID_FORMAT');
    try { return { bytes: await readStream(response.body), revision: strongEtag(response.headers.get('ETag')) }; }
    catch (e) { if (e instanceof VaultError) throw e; throw new VaultError('NETWORK'); }
  }

  /** 在服务器端检查版本条件，绝不退化为无条件 PUT，喵~ */
  async write(bytes: Uint8Array, expectedRevision: string | null): Promise<{ revision: string }> {
    if (this.conditionalWrite !== 'atomic') throw new VaultError('READ_ONLY');
    if (expectedRevision !== null && !strongEtag(expectedRevision)) throw new VaultError('READ_ONLY');
    const response = await this.#request('PUT', { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...(expectedRevision === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedRevision }) }, bytes);
    const revision = strongEtag(response.headers.get('ETag'));
    if (!revision) throw new VaultError('SAVE_FAILED');
    return { revision };
  }
}
