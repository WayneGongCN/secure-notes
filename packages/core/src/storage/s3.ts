import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { GetObjectCommandOutput, PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { VaultError } from '../errors.js';
import type { StoredVault, VaultStore } from '../types.js';
import { httpsUrl, readStream, statusError, strongEtag } from './http.js';

export interface S3Transport {
  /** 对指定对象发送请求，供 SDK 运行时和契约测试共同使用，喵~ */
  send(command: GetObjectCommand | PutObjectCommand, options: { abortSignal: AbortSignal }): Promise<GetObjectCommandOutput | PutObjectCommandOutput>;
}

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  forcePathStyle?: boolean;
  conditionalWritesVerified?: boolean;
  timeoutMs?: number;
  transport?: S3Transport;
}

export class S3Store implements VaultStore {
  readonly conditionalWrite: 'atomic' | 'none';
  readonly #transport: S3Transport;
  readonly #bucket: string;
  readonly #key: string;
  readonly #timeout: number;

  /** 使用显式凭据创建 S3 客户端，不读取默认凭据链或配置文件，喵~ */
  constructor(options: S3Options) {
    const endpoint = httpsUrl(options.endpoint);
    if (!options.region || !options.bucket || !options.key || !options.credentials.accessKeyId || !options.credentials.secretAccessKey) throw new VaultError('INVALID_INPUT');
    const client = options.transport ?? new S3Client({ endpoint, region: options.region, credentials: { ...options.credentials }, forcePathStyle: options.forcePathStyle ?? true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' });
    this.#transport = client as S3Transport; this.#bucket = options.bucket; this.#key = options.key;
    this.#timeout = options.timeoutMs ?? 15_000; this.conditionalWrite = options.conditionalWritesVerified ? 'atomic' : 'none';
  }

  /** 限定请求时长并移除 SDK 异常中的请求和凭据上下文，喵~ */
  async #send(command: GetObjectCommand | PutObjectCommand): Promise<GetObjectCommandOutput | PutObjectCommandOutput> {
    const signal = AbortSignal.timeout(this.#timeout);
    try { return await this.#transport.send(command, { abortSignal: signal }); }
    catch (e) {
      if (signal.aborted) throw new VaultError('TIMEOUT');
      const error = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (['ExpiredToken', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'RequestTimeTooSkewed'].includes(error?.name ?? '')) throw new VaultError('AUTH_FAILED');
      if (error?.$metadata?.httpStatusCode) throw statusError(error.$metadata.httpStatusCode);
      throw new VaultError('NETWORK');
    }
  }

  /** 从同一次 GetObject 返回中读取内容和版本，喵~ */
  async read(): Promise<StoredVault> {
    const output = await this.#send(new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key })) as GetObjectCommandOutput;
    if (!output.Body) throw new VaultError('INVALID_FORMAT');
    try { return { bytes: await readStream(output.Body.transformToWebStream()), revision: strongEtag(output.ETag) }; }
    catch (e) { if (e instanceof VaultError) throw e; throw new VaultError('NETWORK'); }
  }

  /** 使用 SigV4 签名的条件写入，不需要列举或删除对象权限，喵~ */
  async write(bytes: Uint8Array, expectedRevision: string | null): Promise<{ revision: string }> {
    if (this.conditionalWrite !== 'atomic' || (expectedRevision !== null && !strongEtag(expectedRevision))) throw new VaultError('READ_ONLY');
    const output = await this.#send(new PutObjectCommand({ Bucket: this.#bucket, Key: this.#key, Body: bytes, ContentType: 'application/octet-stream', CacheControl: 'no-store', ...(expectedRevision === null ? { IfNoneMatch: '*' } : { IfMatch: expectedRevision }) })) as PutObjectCommandOutput;
    const revision = strongEtag(output.ETag); if (!revision) throw new VaultError('SAVE_FAILED');
    return { revision };
  }
}
