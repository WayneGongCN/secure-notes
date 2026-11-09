import { webcrypto } from 'node:crypto';
import type { Page } from '@playwright/test';
import { VaultSession, VaultCrypto, toBase64, toCtapHmacSalt } from '../packages/core/dist/index.js';
import type { CryptoRuntime, DeriveRequest, HardwareCredential, HardwareKeyProvider } from '../packages/core/dist/index.js';

const runtime = webcrypto;
export interface TestKey { id: number[]; publicKey: number[]; privateJwk: JsonWebKey; seed: number[] }

/** 生成仅用于端到端测试的两把独立软件密钥，不进入应用构建，喵~ */
export async function keys(): Promise<TestKey[]> {
  const result: TestKey[] = [];
  for (let i = 0; i < 2; i++) {
    const pair = await runtime.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    result.push({ id: [...runtime.getRandomValues(new Uint8Array(32))], publicKey: [...new Uint8Array(await runtime.subtle.exportKey('spki', pair.publicKey))], privateJwk: await runtime.subtle.exportKey('jwk', pair.privateKey), seed: [...runtime.getRandomValues(new Uint8Array(32))] });
  }
  return result;
}

/** 为 Node 核心提供与浏览器测试认证器相同的 PRF 输入输出，喵~ */
export function nodeHardware(material: TestKey[]): HardwareKeyProvider {
  let cursor = 0;
  return {
    /** 模拟独立硬件登记，喵~ */
    async enroll(): Promise<HardwareCredential> { const key = material[cursor++]!; return { credentialId: new Uint8Array(key.id), publicKey: new Uint8Array(key.publicKey), algorithm: -7 }; },
    /** 以真实 HMAC 模拟 CTAP 的 UV PRF，用于跨运行时兼容测试，喵~ */
    async deriveSecret(request: DeriveRequest): Promise<Uint8Array> {
      const key = material.find(k => toBase64(new Uint8Array(k.id)) === toBase64(request.credential.credentialId))!;
      if (!key) throw new Error('test key missing');
      const hmac = await runtime.subtle.importKey('raw', new Uint8Array(key.seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const salt = await toCtapHmacSalt(runtime, request.prfInput);
      return new Uint8Array(await runtime.subtle.sign('HMAC', hmac, salt.slice().buffer as ArrayBuffer));
    },
  };
}

/** 在 Node 中创建真实加密文件，供浏览器打开并修改，喵~ */
export async function nodeVault(material: TestKey[]): Promise<Uint8Array> {
  const session = new VaultSession({ crypto: runtime, hardware: nodeHardware(material), rpId: 'localhost' });
  await session.create(await session.enroll('主密钥')); await session.addKey(await session.enroll('备用密钥'));
  await session.addNote('Node 创建的笔记', '这份正文来自无 DOM 的 Node.js 核心。');
  return session.snapshot();
}

/** 在独立测试浏览器注入认证器，不给生产应用留下测试后门，喵~ */
export async function installHardware(page: Page, material: TestKey[]): Promise<void> {
  await page.addInitScript(({ material }) => {
    const state = { next: 0, delay: false, pending: false, release: undefined as (() => void) | undefined, noPrf: false, modalBlur: false };
    Object.assign(window, { __hardwareTest: state });
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    /** 在测试中编码浏览器挑战，喵~ */
    function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
    /** 构造真实 RP 哈希及 UV/UP 标志，喵~ */
    async function authData(rpId: string): Promise<Uint8Array> {
      const bytes = new Uint8Array(37); bytes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)))); bytes[32] = 5; return bytes;
    }
    /** 将真实 Web Crypto 签名编码为 WebAuthn DER 签名，喵~ */
    function der(raw: Uint8Array): ArrayBuffer {
      const integers = [raw.slice(0, 32), raw.slice(32)].map(value => {
        let n = 0; while (n < value.length - 1 && value[n] === 0) n++;
        const bytes = [...value.slice(n)]; if (bytes[0]! & 128) bytes.unshift(0); return [2, bytes.length, ...bytes];
      });
      return new Uint8Array([48, integers[0]!.length + integers[1]!.length, ...integers[0]!, ...integers[1]!]).buffer;
    }
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
      /** 模拟硬件登记的公开响应，喵~ */
      async create({ publicKey: options }: any) {
        if (state.modalBlur) window.dispatchEvent(new Event('blur'));
        const key = material[state.next++]; if (!key) throw new DOMException('Cancelled', 'NotAllowedError');
        const data = await authData(options.rp.id);
        const client = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', origin: location.origin, challenge: b64(new Uint8Array(options.challenge)), crossOrigin: false }));
        return { type: 'public-key', authenticatorAttachment: 'cross-platform', rawId: new Uint8Array(key.id).buffer,
          response: { clientDataJSON: client.buffer, getAuthenticatorData: () => data.buffer, getPublicKey: () => new Uint8Array(key.publicKey).buffer, getPublicKeyAlgorithm: () => -7 },
          getClientExtensionResults: () => ({ prf: { enabled: !state.noPrf } }) };
      },
      /** 用真实 ECDSA 和 HMAC 生成验证响应，并支持迟到回调测试，喵~ */
      async get({ publicKey: options }: any) {
        if (state.modalBlur) window.dispatchEvent(new Event('blur'));
        if (state.delay) { state.pending = true; await new Promise<void>(resolve => { state.release = resolve; }); state.delay = false; state.pending = false; }
        const id = b64(new Uint8Array(options.allowCredentials[0].id));
        const key = material.find(k => b64(new Uint8Array(k.id)) === id)!;
        const data = await authData(options.rpId);
        const client = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', origin: location.origin, challenge: b64(new Uint8Array(options.challenge)), crossOrigin: false }));
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', client)); const signed = new Uint8Array(data.length + hash.length); signed.set(data); signed.set(hash, data.length);
        const privateKey = await crypto.subtle.importKey('jwk', key.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signed);
        const input = new Uint8Array(options.extensions.prf.eval.first); const prefix = new TextEncoder().encode('WebAuthn PRF\0');
        const merged = new Uint8Array(prefix.length + input.length); merged.set(prefix); merged.set(input, prefix.length);
        const salt = await crypto.subtle.digest('SHA-256', merged);
        const hmac = await crypto.subtle.importKey('raw', new Uint8Array(key.seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const secret = await crypto.subtle.sign('HMAC', hmac, salt);
        return { type: 'public-key', authenticatorAttachment: 'cross-platform', rawId: new Uint8Array(key.id).buffer,
          response: { clientDataJSON: client.buffer, authenticatorData: data.buffer, signature: der(new Uint8Array(signature)) },
          getClientExtensionResults: () => state.noPrf ? ({ prf: {} }) : ({ prf: { results: { first: secret } } }) };
      },
    } });
  }, { material });
}
