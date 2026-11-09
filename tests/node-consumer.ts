import { webcrypto } from 'node:crypto';
import { VaultCrypto, VaultSession } from '../packages/core/dist/index.js';
import type { HardwareKeyProvider, CryptoRuntime } from '../packages/core/dist/index.js';

const runtime: CryptoRuntime = webcrypto;
const crypto = new VaultCrypto(runtime);

/** 在不加载 DOM 类型的 Node 项目中检查公共接口可被直接复用，喵~ */
export function nodeConsumer(hardware: HardwareKeyProvider): VaultSession {
  void crypto;
  return new VaultSession({ crypto: runtime, hardware, rpId: 'notes.example' });
}
