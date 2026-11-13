# Secure Notes

[English](README.md) · [中文首页](https://secure-notes.waynegong.com/zh/) · [打开应用](https://secure-notes.waynegong.com/app/)

通过支持 WebAuthn PRF 的通行密钥或 USB FIDO2 安全密钥解锁的客户端加密笔记。纯文本增删改，单个 `.snote` 文件，本地文件 / S3 兼容对象存储 / WebDAV 三选一。无需应用账号或应用服务器。Google Analytics 统计中英文公开首页的访问量。加密笔记应用不加载统计代码。

## 开发与构建

需要 Node.js >= 22.12、pnpm 10.28.2。项目采用两个 workspace 包：

| 包 | 职责 |
| --- | --- |
| `@secure-notes/core` | 笔记业务、文件格式、AES-GCM/HKDF、硬件接口、会话、串行保存与冲突控制、S3/WebDAV |
| `@secure-notes/web` | React 应用、双语推广首页、WebAuthn 适配、本地文件授权、焦点及生命周期事件、PWA |

```sh
pnpm install --frozen-lockfile
pnpm dev
```

本地英文首页为 `http://localhost:5173/`，中文首页为 `http://localhost:5173/zh/`，应用为 `http://localhost:5173/app/`。实体硬件测试固定使用应用的 localhost 地址（即使终端打印监听地址为 127.0.0.1）。WebAuthn 的 RP ID 需要合法域名，HTTP localhost 是开发例外，不能使用 IP 地址作为 RP ID。localhost 和生产域名是不同 RP ID，不能交替使用同一个笔记库。

```sh
pnpm check
pnpm test
pnpm test:e2e
pnpm build
pnpm --filter @secure-notes/web preview --port 4173
```

`check` 同时验证 Web 类型、Core 无 DOM 构建，以及只加载 Node 类型的核心包消费项目。`test` 是无 DOM 的真实密码学与存储契约测试。`test:e2e` 先构建生产包，再使用本机 Google Chrome 运行测试；需要已安装 Chrome，或在 Playwright 配置中选用已安装的 Chromium。

生产静态文件在 `packages/web/dist/`，核心 ESM 与声明文件在 `packages/core/dist/`。从站点根路径托管构建产物，通过 `/app/` 进入应用。

## 密钥与使用

1. 使用支持 WebAuthn PRF 的通行密钥或 USB FIDO2 安全密钥。用户验证由凭据提供方处理，包括 USB 安全密钥的 PIN 输入。
2. 新建库时，登记并验证主密钥后即可保存或导出，也可继续登记、验证备用密钥。仅绑定一枚密钥时，密钥丢失或损坏后将无法解密笔记。
3. 每次打开先读取密文，再通过已绑定的密钥解锁。主备均可独立解锁，USB 安全密钥可在解锁后拔出。
4. 已解锁页面失焦、进入后台、页面离开、手动锁定或前台空闲超时均会关闭会话。浏览器认证弹窗造成的暂时失焦仅遮蔽页面，不取消正在进行的认证；页面隐藏或离开仍会取消，且只有可见、聚焦页面能接收成功结果。默认空闲一分钟，可设置 30 秒或 5 分钟。
5. 保存状态只有确认写入成功才显示“已保存”。iOS/Safari 不支持原地文件保存时使用导出模式；“已导出”不表示已替换原文件或已同步。

使用 KeePassXC 时，请在浏览器扩展中启用通行密钥功能并连接数据库。桌面端和浏览器扩展都需支持 PRF。[浏览器扩展从 1.10.4 开始支持 PRF](https://github.com/keepassxreboot/keepassxc-browser/releases/tag/1.10.4)，KeePassXC 桌面端 2.8.0 尚不支持，发布进度见 [KeePassXC PRF 改动](https://github.com/keepassxreboot/keepassxc/pull/13529)。使用支持 PRF 的版本后，登记主密钥时在 KeePassXC 中保存一枚新通行密钥，验证时在 KeePassXC 中确认使用该密钥，随后保存笔记库。

使用 KeePassXC 通行密钥时，备份应保留含有该通行密钥和 PRF 密钥材料的 KeePassXC 数据库，以及 `.snote` 笔记库文件。

浏览器自动化测试使用真实 ECDSA/HMAC 和 Web Crypto，覆盖模拟通行密钥和 Chrome 虚拟 USB 认证器。实际凭据提供方和浏览器组合需单独验证。

## 存储与凭据

每次只打开一个活动保存位置。“另存到其他位置”复制相同加密格式，不自动建立多个存储之间的双向同步。

本地文件使用用户授权的 File System Access 句柄；不支持时选择文件读取，并导出修改后的加密副本。本地修改检查是内容哈希比对，不是跨进程原子锁。

S3/WebDAV 的凭据只留在当前页面对象内存中，不保存到 localStorage、IndexedDB、笔记库或 URL。锁定清除解密会话，但保留当前页面的存储连接，可以继续上传已经生成的密文。关闭/刷新后重新输入存储凭据。凭据过期时先导出未提交副本，再重新连接。

远端默认只读。启用“允许远端编辑”前，在独立测试库验证服务器正确执行条件请求；应用不会向生产库发送可能覆盖文件的写探测。S3 兼容不等于条件写入兼容。

- 新建始终 `If-None-Match: *`。
- 更新始终 `If-Match: <本次读取对应的强 ETag>`。
- `412/409` 进入冲突状态，停止后续自动保存；选择导出或重新打开，不无条件重试。
- 缺少或只有弱 ETag 的已存在文件只能读取、导出，绝不把“没有版本”当成“可以新建”。
- PUT 成功却缺少 ETag，或响应超时/丢失时，回读相同密文与强 ETag 后才确认成功。
- 整库写回，本地约 500ms，远端约 2s 防抖。网络中断后可编辑已打开内容；未上传密文只在本页内存中，必须上传或导出后再关闭。

### S3

填写 Endpoint、Region、Bucket、Object Key、Access Key ID、Secret Access Key，可选 Session Token 和路径式地址。使用 AWS SDK v3 / SigV4，关闭 SDK 自动重试并显式提供凭据，不读取默认凭据链。

优先使用短期凭据；专用长效凭据的 IAM 权限限定到单个对象的 `s3:GetObject` 和 `s3:PutObject`。笔记删除是加密库内容更新，不需要 `DeleteObject` 或 `ListBucket`。后端支持时配置版本历史与独立备份；历史版本仍可能包含已删除笔记。

示例桶 CORS（替换应用域名）：

```json
[
  {
    "AllowedOrigins": ["https://secure-notes.waynegong.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["authorization", "content-type", "cache-control", "if-match", "if-none-match", "x-amz-*", "amz-sdk-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 300
  }
]
```

参考：[S3 条件写入](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)。

### WebDAV

填写准确的 HTTPS 文件地址、用户名和可撤销应用密码；目录需事先存在。不进行目录遍历、文件锁续租或隐式跳转。

服务/反向代理必须允许应用 Origin 的 GET、PUT 和 OPTIONS；预检无需登录即可响应。允许 `Authorization, Content-Type, Cache-Control, If-Match, If-None-Match` 请求头，暴露 `ETag`，并为错误响应设置同样的 CORS 头。Authorization 应显式列出，不能只依赖通配符。无须浏览器 Cookie；应用显式发送 Basic Auth，必须使用受信 HTTPS。

Nextcloud 地址通常为 `https://host/remote.php/dav/files/用户名/目录/Notes.snote`；推荐专用账号/目录权限和应用密码。参考：[WebDAV 标准](https://www.rfc-editor.org/rfc/rfc4918.html)、[Nextcloud 文档](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html)。

## 部署与安全边界

### Vercel 发布

正式站点的英文首页 `/`、中文首页 `/zh/`、应用 `/app/` 共用一个静态部署。工作流使用 GitHub 的 `production` 环境，其中 `VERCEL_TOKEN` 是 Secret，`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`、`PRODUCTION_HOSTNAME` 是变量。

为 `main` 上已验证的提交推送 `v主版本.次版本.补丁版本` 格式的新 Tag 即可发布。例如：

```sh
git tag -a v0.1.0 -m "Secure Notes v0.1.0"
git push origin v0.1.0
```

工作流校验 Tag 指向的提交并执行测试，然后将构建产物上传到 Vercel。线上应用使用当前访问的主机名作为 WebAuthn RP ID。双语首页、应用资源和 PWA 验证通过后，再将同一份产物提升到正式域名。

旧 Vercel 域名创建的笔记库继续在[原应用](https://secure-notes-waynegongcn.vercel.app/app/)解锁。新笔记库在自定义域名创建。若仍在原域名使用远程笔记库，请在存储端 CORS 配置中同时允许两个来源。

### 自托管与安全边界

部署 `packages/web/dist/` 到用户长期控制的独立 HTTPS Origin，不与其他可写应用共用域名；可通过 `packages/web/.env.local` 中的 `VITE_RP_ID` 在构建时固定域名，默认当前 hostname。域名必须与页面 hostname 相同。保留域名控制权、应用部署包、备份文件和备用硬件；普通网页不能在任意另一个域名使用原凭据。

生产包包含严格的脚本/样式 CSP，无第三方 CDN；可设置服务器响应头 `frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。默认 CSP 为支持自选存储放行 HTTPS 连接；个人部署建议将 `connect-src` 收窄到实际存储域名。

Service Worker 作用域为 `/app/`，只预缓存应用构建清单内的同源静态资源，不缓存 API、凭据或 `.snote`。首次成功加载并安装离线资源后，本地文件模式可离线使用；远端首次读取需要网络。更新不调用 `skipWaiting`，关闭旧页面后才激活新版本。

内容（包括标题、正文和时间）采用 AES-256-GCM，WebAuthn PRF 输出经 HKDF 派生后包装随机库密钥。公开头部包含库标识、域名、密钥标签与凭据标识，存储方可见大小、访问频率等元数据。加密不能阻止存储方删除或回放旧版本。

纯 Web 不能可靠禁止系统截图；JavaScript 不能保证物理擦除所有内存副本。此实现不防恶意同源脚本、被控制的 OS、键盘或浏览器扩展。锁定后 Core 拒绝明文访问，Web 清除界面副本；其他客户端复用 Core 时也必须清理自己持有的明文副本。

## 后续客户端

Core 的公开协议、运行时注入和 PRF 域分离见 [核心包说明](packages/core/README.md)。Node CLI 可以直接消费 ESM 与声明文件，提供硬件/文件适配即可。Swift/Kotlin 需 JS 运行时桥接及标准密码学能力；本项目不包含 CLI、原生 FFI 或真实 CTAP 驱动。
