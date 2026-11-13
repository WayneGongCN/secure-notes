# Secure Notes

[简体中文](README.zh-CN.md) · [Website](https://secure-notes.waynegong.com/) · [Open the app](https://secure-notes.waynegong.com/app/)

Secure Notes is a client-side encrypted notebook that unlocks with a WebAuthn PRF passkey or USB FIDO2 security key. Create, edit, and delete plain-text notes and store them in a single encrypted `.snote` file. Choose a local file, S3-compatible object storage, or WebDAV. The app runs in the browser without an application account or application server. Google Analytics measures visits to the public English and Chinese homepages. The notebook app does not load the analytics tag.

## Development and builds

Requires Node.js 22.12 or later and pnpm 10.28.2. The repository contains two workspace packages.

| Package | Responsibility |
| --- | --- |
| `@secure-notes/core` | Note operations, vault format, AES-GCM/HKDF, hardware interface, sessions, serialized writes, conflict handling, and S3/WebDAV |
| `@secure-notes/web` | React UI, English and Chinese landing pages, browser WebAuthn, local file access, focus and page lifecycle, and PWA |

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the English homepage at `http://localhost:5173/`, the Chinese homepage at `http://localhost:5173/zh/`, or the app at `http://localhost:5173/app/`. For hardware tests, use the `localhost` hostname even if the terminal prints `127.0.0.1`. WebAuthn allows HTTP on localhost as a development exception and requires a hostname for the RP ID. A vault is tied to its RP ID, so local and production vaults use separate credentials.

```sh
pnpm check
pnpm test
pnpm test:e2e
pnpm build
pnpm --filter @secure-notes/web preview --port 4173
```

`check` validates Web types, the DOM-free Core build, and a Core consumer with Node types only. `test` exercises real cryptography and storage contracts without the DOM. `test:e2e` builds the production bundle and runs Playwright with Google Chrome. Install Chrome or use `pnpm exec playwright install chrome`.

Serve the static output in `packages/web/dist/` over HTTP on localhost or HTTPS in production. Core ESM and type declarations are built in `packages/core/dist/`.

## Unlock keys and daily use

1. Use a passkey or USB FIDO2 key that supports WebAuthn PRF. The credential provider handles user verification, including FIDO2 PIN entry.
2. Register and verify a primary key before saving or exporting a new vault. A verified backup key can unlock the vault independently. If you register only one key and lose it, a copy of the vault file alone cannot recover your notes.
3. To open a vault, first load its encrypted file, then unlock it with a registered key. You can unplug a USB key after unlocking.
4. The session locks when you switch focus, put the page in the background, leave the page, lock manually, or reach the idle timeout. Temporary blur from the browser's authentication dialog covers the page while authentication continues. Results are accepted only when the page is visible and focused. The default idle timeout is one minute, with 30 seconds and five minutes also available.
5. The app shows “Saved” after it confirms a write. When in-place saving is unavailable, including on some Safari and iOS versions, export an encrypted copy and replace the original file yourself.

For KeePassXC, enable passkeys in the browser extension and connect it to your database. Both components need PRF support. The [browser extension added PRF in 1.10.4](https://github.com/keepassxreboot/keepassxc-browser/releases/tag/1.10.4). KeePassXC desktop 2.8.0 lacks this support. Follow [the desktop PRF change](https://github.com/keepassxreboot/keepassxc/pull/13529) for availability. With a PRF-capable build, choose to save a new passkey to KeePassXC when registering the primary key, then approve verification in KeePassXC before saving the vault.

When using a KeePassXC passkey, keep a backup of the KeePassXC database containing its PRF secret so you can still unlock a copy of the `.snote` file.

Browser tests exercise cryptography, simulated passkeys, and a virtual WebAuthn USB authenticator. Actual credential-provider and browser combinations need separate verification.

## Storage and credentials

Open one active storage location at a time. Saving a copy uses the same encrypted format across providers. Each copy is managed separately.

Local writes use a file handle granted by the user. Browsers without file handle support can read a selected file and export changes. Local conflict detection compares content hashes, so concurrent processes can still race.

S3 and WebDAV credentials stay in memory for the current page. Locking clears the decrypted session and keeps the connection available for already-encrypted writes. Refreshing or closing the page clears the storage credentials. Export uncommitted changes before reconnecting with fresh credentials.

Remote vaults open read-only by default. Before enabling remote edits, verify conditional writes against a separate test vault on the chosen server.

- Creating a vault requires `If-None-Match: *`. Updating one requires `If-Match` with the strong ETag from the current read.
- HTTP `412` or `409` stops automatic saves. Export a copy or reopen the vault to resolve the conflict.
- Existing vaults with a weak or missing ETag can be read and exported.
- If the PUT response is lost or has no ETag, the app confirms the write by reading back identical ciphertext with a strong ETag.
- Saves write the whole vault after a debounce of roughly 500 ms locally or two seconds remotely. You can continue editing an open vault during an outage. Upload or export the pending ciphertext before closing the page.

### S3

Supply the endpoint, region, bucket, object key, access key ID, and secret access key. Session tokens and path-style addressing are optional. The app signs requests with AWS SDK v3 and SigV4 using the supplied credentials, with automatic retries disabled.

Prefer short-lived credentials. Scope a dedicated long-lived IAM credential to `s3:GetObject` and `s3:PutObject` on the vault object. Where available, enable version history and keep independent backups. Older vault versions can contain deleted notes.

Example bucket CORS configuration for the hosted app. Replace the origin for self-hosting.

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

See [S3 conditional requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html) and [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html).

### WebDAV

Supply the exact HTTPS file URL, username, and a revocable app password. Create the parent directory first. The app reads or writes the specified file with Basic Auth over trusted HTTPS.

Allow the app's origin to send GET, PUT, and unauthenticated OPTIONS requests. Explicitly allow the `Authorization`, `Content-Type`, `Cache-Control`, `If-Match`, and `If-None-Match` headers, expose `ETag`, and return the same CORS headers on errors.

A typical Nextcloud file URL is `https://host/remote.php/dav/files/username/folder/Notes.snote`. Prefer a dedicated account or directory with an app password. See [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html) and the [Nextcloud WebDAV documentation](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html).

## Deployment and security boundaries

### Vercel releases

The Vercel project serves all three routes from the same static build. The release workflow uses the GitHub `production` environment with the `VERCEL_TOKEN` secret and the `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and `PRODUCTION_HOSTNAME` variables.

To release a tested commit on `main`, push a new tag in `vMAJOR.MINOR.PATCH` format. For example:

```sh
git tag -a v0.1.0 -m "Secure Notes v0.1.0"
git push origin v0.1.0
```

The workflow validates the tagged commit, runs tests, and stages the Vercel deployment. The hosted app uses the current hostname as its WebAuthn RP ID. It checks the homepage in both languages, the app bundle, and the PWA before promoting the deployment.

Existing vaults created on the Vercel domain still open at the [original app](https://secure-notes-waynegongcn.vercel.app/app/). Create new vaults on the custom domain. For remote storage, allow both origins in CORS if you still use vaults on the original domain.

### Self-hosting

Serve the static build at the root of a dedicated HTTPS origin you control. To pin the RP ID, set `VITE_RP_ID` at build time or in `packages/web/.env.local`. By default, it uses the page hostname. The RP ID must match the hostname exactly. Keep access to the original domain, a copy of the deployment, vault backups, and a backup key.

The production app has a script and style CSP and serves its assets directly. To support user-chosen storage endpoints, the app's CSP permits outbound HTTPS connections. For a personal deployment you can restrict `connect-src` to your storage origins. The included Vercel configuration also sets framing, referrer, and MIME-sniffing policies.

The Service Worker controls `/app/` and caches only the allowlisted app shell and static assets. Once those assets install, the app can open a local file offline. Reading remote files requires a connection. Updates activate once the old app pages close.

### Vault and browser limits

Note titles, text, and timestamps use AES-256-GCM. HKDF derives a wrapping key from the WebAuthn PRF output to protect a random vault key. The public header includes the vault ID, hostname, key labels, and credential IDs. Storage providers can see file sizes and access patterns and can delete or replay older encrypted versions.

Browser code cannot reliably prevent OS screenshots or physically erase every memory copy. Trusted same-origin code, the operating system, keyboard, and browser extensions are part of the security boundary. Core rejects plaintext access after locking, and the Web app clears the plaintext it displays. Other Core consumers must clear their own copies.

## Other clients

See the [Core documentation](packages/core/README.md) for the public vault format, runtime adapters, and PRF domain separation. A Node.js CLI can consume Core's ESM and type declarations with hardware and file adapters. Swift or Kotlin clients would need a JavaScript runtime bridge and compatible cryptographic primitives.
