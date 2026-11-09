# @secure-notes/core

不依赖 React、DOM 或浏览器存储的业务核心。采用 ESM 与 TypeScript 声明；构建和 Node 消费检查均不加载 DOM 类型。默认入口不导入 AWS SDK。

## 入口和职责

```ts
import { VaultSession, VaultCodec, VaultCrypto, VaultPersistence } from '@secure-notes/core';
import { S3Store } from '@secure-notes/core/storage/s3';
import { WebDavStore } from '@secure-notes/core/storage/webdav';
```

- `VaultSession`：登记硬件、创建、增加备用槽、解锁、CRUD、密文快照、空闲检查与锁定。
- `VaultCodec`：密文格式及解密后笔记模型的结构验证。
- `VaultCrypto`：标准 AES-GCM/HKDF 操作及 CTAP 域分离辅助函数。业务应用应通过 `VaultSession` 访问库密钥。
- `VaultPersistence`：单一保存位置、串行条件写入、冲突状态和不确定结果核实。

结构化 `SessionState` 和 `PersistenceState` 不包含明文、库密钥、PRF 输出或访问凭据。订阅返回的函数用于解除订阅；监听异常不会中断安全清理。所有错误用 `VaultError.code` 表示，不包含底层请求/认证对象；客户端自行映射文案。

## 注入运行时

`VaultSession({ crypto, hardware, rpId, now?, idleTimeoutMs? })`。

- 浏览器直接注入 `globalThis.crypto`。
- Node 直接注入 `node:crypto` 的 `webcrypto`，无需类型强转或 DOM 类型库。
- `CryptoRuntime` 只描述标准 Web Crypto 的最小结构（SHA-256、AES-GCM、HKDF、CSPRNG），没有实现自定义密码算法。传入的密钥句柄必须是该平台真实的 CryptoKey，不能用普通对象代替。
- 可选 `now()` 返回单调毫秒时间。运行时定时器调用 `checkIdle()`，核心在所有明文入口再次检查期限。

JS 宿主还需提供 UTF-8 编解码、AbortController / AbortSignal.any / AbortSignal.timeout 和单调时钟；使用远端适配器时提供标准 Fetch / 流能力。现代浏览器和目标 Node 版本均具备这些能力，原生 JS 桥接端需要补齐相应运行时设施。

`HardwareKeyProvider` 是受信的平台适配接口：

```ts
interface HardwareKeyProvider {
  enroll(request: EnrollRequest): Promise<HardwareCredential>;
  deriveSecret(request: DeriveRequest): Promise<Uint8Array>;
}
```

登记输出为凭据 ID、公钥 SPKI 和 ES256 算法标识 `-7`。派生接口必须验证 RP、原始挑战、用户在场和用户验证，返回等价 WebAuthn PRF 的 32 字节输出；不允许签名结果、随机软件密钥或本机/云同步通行密钥代替。Web 适配器验证 origin、challenge、RP hash、UP/UV、签名和非备份标志；PIN 不进入核心。

每一次调用都有取消信号。即使驱动不遵守取消，核心也会用会话代次拒绝迟到结果。接口数据是普通对象/字节数组，不暴露 PublicKeyCredential、DOM Event 或 File。

最小创建流程是 `enroll(主) → create(主)`，主密钥验证成功后即可 `snapshot()` 保存，锁定后仍可导出已有密文。备用密钥可选，核心支持通过 `enroll(备) → addKey(备)` 增加独立解锁槽；客户端为每一步提供显式用户操作。仅登记但未完成 `create()` 验证时不能保存。仅绑定一把密钥时，丢失或损坏后无法解密；程序无法可靠证明两个凭据必定来自不同实物，配置备用密钥时请引导用户使用另一把实物。

## 固定文件格式 v1

文件是 UTF-8 JSON，扩展名 `.snote`，最大 16 MiB。未知版本/算法直接拒绝。结构如下；字符串字节均为无填充、规范 base64url：

```text
format: "secure-notes"
version: 1
vaultId: 16 个随机字节的小写十六进制
rpId: 固定应用 hostname
keySlots: [
  { label, credentialId, publicKey, algorithm: -7,
    prfInput, hkdfSalt, wrappedKey: { iv, data } }
]
payload: { iv, data }
```

密钥槽最少 1 个、最多 8 个；备用槽可选。每槽 `prfInput` 和 `hkdfSalt` 均为独立随机 32 字节。标题最长 200 个 UTF-16 code unit，单篇正文最长 1 Mi 个 code unit，最多一万篇；整个密文文件仍受 16 MiB 边界限制。

### 包装随机库密钥

随机库密钥为 32 字节，绝不从 PIN、凭据 ID 或签名推导。每槽依次执行：

1. `PRF = provider.deriveSecret(prfInput)`，返回已完成 UV 的 32 字节标准 WebAuthn PRF 输出。
2. `HKDF-SHA-256(IKM=PRF, salt=hkdfSalt, info=UTF8("secure-notes/v1/wrap\0" + vaultId + "\0" + credentialId))`，派生 AES-256-GCM 包装密钥。
3. 随机 nonce 12 字节，标签 128 bit，密文 32+16=48 字节。
4. 包装 AAD 为以下 JSON 数组的 UTF-8 编码（无额外空白）：

```text
["secure-notes",1,vaultId,rpId,label,credentialId,publicKey,-7,prfInput,hkdfSalt]
```

`data` 是 Web Crypto 返回的 ciphertext || tag，`iv` 和 `data` 分别编码。每次加密都生成新 nonce。

### 笔记密文

明文为 `JSON.stringify({ notes })` 的 UTF-8；每篇为 `{ id,title,body,createdAt,updatedAt }`，时间使用 ISO 字符串。

正文 AES-256-GCM 使用同一随机库密钥、独立随机 12 字节 nonce 和 128 bit 标签。AAD 是公开头部的固定字段顺序 JSON：

```text
{ format,version,vaultId,rpId,keySlots }
```

密钥槽字段顺序为 `label,credentialId,publicKey,algorithm,prfInput,hkdfSalt,wrappedKey`；密文块顺序为 `iv,data`。解析器先重建这些固定顺序再认证，不能直接使用输入文件原始空白或属性顺序。认证覆盖主/备槽及其标签；修改任一公开头部会导致验证失败。

### CLI / 原生 CTAP 互通

Web 客户端将文件中的 `prfInput` 原样传给浏览器 `prf.eval.first`。浏览器按 WebAuthn 规范执行：

```text
ctapSalt = SHA-256(UTF8("WebAuthn PRF") || 0x00 || prfInput)
```

直接调用 CTAP 的客户端需执行一次此转换（核心导出 `toCtapHmacSalt`），使用原文件中的 RP ID / credential ID，并启用同等用户验证，然后将解密后的 hmac-secret 输出作为 PRF 结果。不可漏算或重复计算前缀，不可混用未验证用户的 secret。

固定向量来自 [WebAuthn 标准](https://w3c.github.io/webauthn/#prf-extension)：输入 UTF8(`WebAuthn PRF test vectors`) 后拼接 `0x02`，输出盐十六进制为 `527413ebb48293772df30f031c5ac4650c7de14bf9498671ae163447b6a772b3`。变更上述协议时必须增加文件版本。

## 保存与生命周期

`VaultPersistence.open()` 返回密文字节，随后由 `session.load(bytes)` 装载。显式新建使用 `create(bytes)`。变更后先 `markDirty()`，再保存 `await session.snapshot()`；快照与存储端只交换密文。

`VaultStore` 的 `conditionalWrite` 为 `atomic | best-effort | none`。`read()` 返回 `bytes` 与可选版本；`write(bytes, expectedRevision)` 中 null 只表示显式新建，已有但缺少版本时不能写。强 ETag 保留原样，不视为 MD5。

保存队列串行执行；冲突后拒绝后续覆盖。网络超时/丢失或 PUT 缺少版本时回读，内容字节与对应强 ETag 均确认后才成功。较旧保存响应不能把新编辑标记为已保存。

`lock()` 清理核心可控的原始密钥与笔记引用，拒绝之后的明文访问。已开始的封存可完成并留下密文，但不能返回旧会话的明文结果。`reset()` 进一步关闭当前库并使旧文档任务失效。任何客户端都必须在锁定通知后清理自己持有的明文副本；JavaScript 不保证物理擦除。
