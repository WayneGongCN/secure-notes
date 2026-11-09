import { VaultError } from './errors.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 使用不依赖 Buffer 或浏览器编码函数的规范 base64url 表示，喵~ */
export function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = []; let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!; const b = bytes[i + 1]; const c = bytes[i + 2];
    chunk += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) chunk += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) chunk += alphabet[c & 63]!;
    if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join('');
}

/** 严格解码无填充 base64url，拒绝非规范编码，喵~ */
export function fromBase64(value: string, max = 16 * 1024 * 1024): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1 || value.length > Math.ceil(max * 4 / 3)) {
    throw new VaultError('INVALID_FORMAT');
  }
  const result = new Uint8Array(Math.floor(value.length * 6 / 8));
  let bits = 0; let acc = 0; let offset = 0;
  for (const ch of value) {
    acc = (acc << 6) | alphabet.indexOf(ch); bits += 6;
    if (bits >= 8) { bits -= 8; result[offset++] = (acc >> bits) & 255; }
  }
  if (bits && (acc & ((1 << bits) - 1))) throw new VaultError('INVALID_FORMAT');
  return result;
}

/** 为 Web Crypto 提供独立的普通 ArrayBuffer，喵~ */
export function buffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }

/** 比较密文字节，用于结果丢失后的写入确认，喵~ */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/** 编码文件规范使用的 UTF-8 文本，喵~ */
export function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }

/** 严格解码 UTF-8，避免替换字符造成文件语义变化，喵~ */
export function text(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new VaultError('INVALID_FORMAT'); }
}
