import { MAX_VAULT_BYTES } from '../codec.js';
import { VaultError } from '../errors.js';

/** 将 HTTP 状态转换为不含 URL、账号和请求头的错误码，喵~ */
export function statusError(status: number): VaultError {
  if (status === 401) return new VaultError('AUTH_FAILED');
  if (status === 403) return new VaultError('PERMISSION_DENIED');
  if (status === 404) return new VaultError('NOT_FOUND');
  if ([409, 412, 423].includes(status)) return new VaultError('CONFLICT');
  if ([405, 501].includes(status)) return new VaultError('READ_ONLY');
  return new VaultError('NETWORK');
}

/** 只接受可用于 If-Match 的强 ETag，不把 ETag 当作内容哈希，喵~ */
export function strongEtag(value: unknown): string | undefined {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\uffff]*"$/.test(value) ? value : undefined;
}

/** 验证可公开配置的 HTTPS 端点，拒绝 URL 内嵌凭据，喵~ */
export function httpsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new VaultError('INVALID_INPUT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new VaultError('INVALID_INPUT');
  return url.href;
}

/** 有界读取网络密文，避免响应体使客户端无限增长内存，喵~ */
export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_VAULT_BYTES) { await reader.cancel(); throw new VaultError('INVALID_FORMAT'); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
