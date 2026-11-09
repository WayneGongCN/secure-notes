import { VaultError, equalBytes, toBase64 } from '@secure-notes/core';
import type { DeriveRequest, EnrollRequest, HardwareCredential, HardwareKeyProvider } from '@secure-notes/core';

/** 将标准字节数组转换为浏览器 Web Crypto 可接受的独立缓冲区，喵~ */
function buffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }

/** 只向受信 HTTPS 或 localhost 开发环境开放硬件操作，喵~ */
function requireSupport(rpId: string): void {
  if (!isSecureContext || !navigator.credentials || !globalThis.PublicKeyCredential) throw new VaultError('UNSUPPORTED');
  if (rpId !== location.hostname || /^\d+\.\d+\.\d+\.\d+$/.test(rpId) || rpId.includes(':')) throw new VaultError('RP_MISMATCH');
}

/** 认证窗口关闭后等待页面恢复焦点；隐藏、取消或超时均不得交付结果，喵~ */
async function requireActivePage(signal: AbortSignal): Promise<void> {
  if (signal.aborted || document.hidden) throw new VaultError('CANCELLED');
  if (document.hasFocus()) return;
  await new Promise<void>((resolve, reject) => {
    /** 清理一次认证焦点等待的监听器和定时器，喵~ */
    function cleanup(): void {
      clearTimeout(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); signal.removeEventListener('abort', check);
    }
    /** 只在当前可见页面聚焦后完成，隐藏和取消则拒绝，喵~ */
    function check(): void {
      if (signal.aborted || document.hidden) { cleanup(); reject(new VaultError('CANCELLED')); }
      else if (document.hasFocus()) { cleanup(); resolve(); }
    }
    const timer = setTimeout(() => { cleanup(); reject(new VaultError('CANCELLED')); }, 2000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check); signal.addEventListener('abort', check, { once: true }); check();
  });
  if (signal.aborted || document.hidden || !document.hasFocus()) throw new VaultError('CANCELLED');
}

/** 验证浏览器返回的客户端数据，拒绝跨源和错误挑战，喵~ */
function verifyClientData(bytes: ArrayBuffer, challenge: Uint8Array, type: string): void {
  let data: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new VaultError('AUTH_FAILED'); }
  if (data.type !== type || data.challenge !== toBase64(challenge) || data.origin !== location.origin || data.crossOrigin === true) throw new VaultError('AUTH_FAILED');
}

/** 验证 RP 哈希、用户在场和用户验证，并拒绝可同步凭据，喵~ */
async function verifyAuthenticatorData(bytes: ArrayBuffer, rpId: string): Promise<void> {
  const data = new Uint8Array(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  if (data.length < 37 || !equalBytes(data.slice(0, 32), hash) || (data[32]! & 5) !== 5 || (data[32]! & 0x18) !== 0) throw new VaultError('AUTH_FAILED');
}

/** 将 WebAuthn ES256 的 DER 签名转换为 Web Crypto 所需的固定长度签名，喵~ */
function derSignature(bytes: ArrayBuffer): ArrayBuffer {
  const data = new Uint8Array(bytes);
  if (data[0] !== 0x30 || data[1] !== data.length - 2 || data[2] !== 2) throw new VaultError('AUTH_FAILED');
  const rLength = data[3]!; const sOffset = 4 + rLength;
  if (rLength < 1 || rLength > 33 || data[sOffset] !== 2) throw new VaultError('AUTH_FAILED');
  const sLength = data[sOffset + 1]!;
  if (sLength < 1 || sLength > 33 || sOffset + 2 + sLength !== data.length) throw new VaultError('AUTH_FAILED');
  const r = data.slice(4, sOffset); const s = data.slice(sOffset + 2);
  const result = new Uint8Array(64);
  for (const [index, integer] of [r, s].entries()) {
    const normalized = integer.length === 33 && integer[0] === 0 ? integer.slice(1) : integer;
    if (normalized.length > 32 || (!integer[0] && integer.length > 1 && (integer[1]! & 0x80) === 0) || (integer[0]! & 0x80)) throw new VaultError('AUTH_FAILED');
    result.set(normalized, index * 32 + 32 - normalized.length);
  }
  return buffer(result);
}

/** 将平台认证异常转换为不包含设备详情和凭据的业务错误，喵~ */
function hardwareError(error: unknown, operation: 'enroll' | 'derive', stage: string, signal: AbortSignal): VaultError {
  const name = (error as { name?: string })?.name;
  const safeName = error instanceof VaultError ? error.code : ['AbortError', 'NotAllowedError', 'NotSupportedError', 'SecurityError', 'TypeError'].includes(name ?? '') ? name : 'UnknownError';
  console.info('[硬件认证]', { operation, stage, error: safeName, aborted: signal.aborted, visible: !document.hidden, focused: document.hasFocus() });
  if (error instanceof VaultError) return error;
  return new VaultError(name === 'AbortError' || name === 'NotAllowedError' ? 'CANCELLED' : name === 'NotSupportedError' ? 'UNSUPPORTED' : 'AUTH_FAILED');
}

type PrfOutput = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

export class BrowserHardwareKeyProvider implements HardwareKeyProvider {
  /** 调用浏览器登记 USB 外置密钥，并验证用户验证及 PRF 能力，喵~ */
  async enroll(request: EnrollRequest): Promise<HardwareCredential> {
    requireSupport(request.rpId);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    let stage = 'request';
    try {
      const options: PublicKeyCredentialCreationOptions & { hints: string[] } = {
        rp: { id: request.rpId, name: 'Secure Notes' },
        user: { id: buffer(request.userId), name: `notes-${toBase64(request.userId).slice(0, 12)}`, displayName: request.label },
        challenge: buffer(challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'cross-platform', residentKey: 'discouraged', userVerification: 'required' },
        attestation: 'none', timeout: 60_000, hints: ['security-key'],
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      };
      const credential = await navigator.credentials.create({ publicKey: options, signal: request.signal }) as PublicKeyCredential | null;
      stage = 'validate-credential';
      if (!credential || credential.type !== 'public-key' || credential.authenticatorAttachment !== 'cross-platform') throw new VaultError('UNSUPPORTED');
      const response = credential.response as AuthenticatorAttestationResponse;
      stage = 'validate-client';
      verifyClientData(response.clientDataJSON, challenge, 'webauthn.create');
      stage = 'validate-authenticator';
      await verifyAuthenticatorData(response.getAuthenticatorData(), request.rpId);
      stage = 'check-prf';
      if (!(credential.getClientExtensionResults() as PrfOutput).prf?.enabled) throw new VaultError('UNSUPPORTED');
      const publicKey = response.getPublicKey();
      if (!publicKey || response.getPublicKeyAlgorithm() !== -7) throw new VaultError('UNSUPPORTED');
      stage = 'wait-for-page-focus';
      await requireActivePage(request.signal);
      return { credentialId: new Uint8Array(credential.rawId), publicKey: new Uint8Array(publicKey), algorithm: -7 };
    } catch (e) { throw hardwareError(e, 'enroll', stage, request.signal); }
  }

  /** 验证签名和 UV 后交付 PRF 输出；网页只传原始输入，不重复做域分离，喵~ */
  async deriveSecret(request: DeriveRequest): Promise<Uint8Array> {
    requireSupport(request.rpId);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    let stage = 'request'; let output: Uint8Array | undefined;
    try {
      const options: PublicKeyCredentialRequestOptions & { hints: string[] } = {
        rpId: request.rpId, challenge: buffer(challenge), timeout: 60_000,
        allowCredentials: [{ id: buffer(request.credential.credentialId), type: 'public-key', transports: ['usb'] }],
        userVerification: 'required', hints: ['security-key'],
        extensions: { prf: { eval: { first: buffer(request.prfInput) } } } as AuthenticationExtensionsClientInputs,
      };
      const credential = await navigator.credentials.get({ publicKey: options, signal: request.signal }) as PublicKeyCredential | null;
      stage = 'validate-credential';
      if (!credential || credential.type !== 'public-key' || !equalBytes(new Uint8Array(credential.rawId), request.credential.credentialId)) throw new VaultError('WRONG_KEY');
      const response = credential.response as AuthenticatorAssertionResponse;
      stage = 'validate-client';
      verifyClientData(response.clientDataJSON, challenge, 'webauthn.get');
      stage = 'validate-authenticator';
      await verifyAuthenticatorData(response.authenticatorData, request.rpId);
      stage = 'validate-signature';
      const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', response.clientDataJSON));
      const signed = new Uint8Array(response.authenticatorData.byteLength + clientHash.length);
      signed.set(new Uint8Array(response.authenticatorData)); signed.set(clientHash, response.authenticatorData.byteLength);
      const publicKey = await crypto.subtle.importKey('spki', buffer(request.credential.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, derSignature(response.signature), buffer(signed))) throw new VaultError('AUTH_FAILED');
      stage = 'check-prf';
      const secret = (credential.getClientExtensionResults() as PrfOutput).prf?.results?.first;
      if (!secret || secret.byteLength !== 32) throw new VaultError('UNSUPPORTED');
      output = new Uint8Array(secret); stage = 'wait-for-page-focus';
      await requireActivePage(request.signal); return output;
    } catch (e) { output?.fill(0); throw hardwareError(e, 'derive', stage, request.signal); }
  }
}
