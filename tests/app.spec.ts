import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { VaultCodec, VaultSession } from '../packages/core/dist/index.js';
import type { CryptoRuntime } from '../packages/core/dist/index.js';
import { installHardware, keys, nodeHardware, nodeVault } from './browser-hardware';

test('认证弹窗暂时失焦时仍可完成双硬件配置、导出与恢复', async ({ page }) => {
  const material = await keys(); await installHardware(page, material); await page.goto('/app/');
  await page.evaluate(() => { (window as any).__hardwareTest.modalBlur = true; });
  await page.getByRole('button', { name: '新建笔记库', exact: true }).click();
  for (const label of ['登记主密钥', '验证主密钥', '登记备用密钥（可选）', '验证备用密钥']) {
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  const firstDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '选择位置并保存' }).click(); await firstDownload;
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill('端到端测试私有标题');
  await page.getByRole('textbox', { name: '笔记正文' }).fill('浏览器 Web Crypto 写入的内容，不能出现在密文中。');
  const nextDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出副本', exact: true }).click();
  const download = await nextDownload; const bytes = new Uint8Array(await readFile((await download.path())!));
  expect(new TextDecoder().decode(bytes)).not.toContain('私有标题');
  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('端到端测试私有标题');
  await page.locator('.key-select select').selectOption({ label: '备用密钥' });
  await page.getByRole('button', { name: '使用密钥解锁' }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveValue('浏览器 Web Crypto 写入的内容，不能出现在密文中。');
  const node = new VaultSession({ crypto: webcrypto as unknown as CryptoRuntime, hardware: nodeHardware(material), rpId: 'localhost' });
  node.load(bytes); await node.unlock(); expect(node.listNotes()[0]?.title).toBe('端到端测试私有标题');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('button', { name: '锁定', exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin: 'http://localhost:4173', storageTypes: 'all' });
  await cdp.detach();
  await page.reload(); await page.getByRole('button', { name: '打开已有笔记库' }).click();
  await page.getByLabel('选择加密笔记库').setInputFiles({ name: 'Notes.snote', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await page.getByRole('button', { name: '使用密钥解锁' }).click();
  await expect(page.getByRole('button', { name: /端到端测试私有标题/ })).toBeVisible();
});

for (const skipAfterRegistration of [false, true]) {
  test(skipAfterRegistration ? '备用密钥仅登记未验证时，锁定后仍可跳过并保存主密钥库' : '只验证主密钥即可创建、编辑、导出和重新解锁', async ({ page }) => {
    const material = await keys(); await installHardware(page, material); await page.goto('/app/');
    await page.getByRole('button', { name: '新建笔记库', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择位置并保存', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '登记主密钥', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择位置并保存', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '验证主密钥', exact: true }).click();
    await expect(page.getByRole('button', { name: '登记备用密钥（可选）', exact: true })).toBeVisible();
    await expect(page.getByText('仅绑定一枚密钥时，密钥丢失或损坏后将无法解密笔记。')).toBeVisible();
    if (skipAfterRegistration) {
      await page.getByRole('button', { name: '登记备用密钥（可选）', exact: true }).click();
      await expect(page.getByRole('button', { name: '验证备用密钥', exact: true })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    }
    const createdDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: skipAfterRegistration ? '跳过备用密钥并保存' : '选择位置并保存', exact: true }).click();
    const created = await createdDownload;
    expect(VaultCodec.parse(new Uint8Array(await readFile((await created.path())!))).keySlots).toHaveLength(1);
    await expect(page.getByText('1 枚已绑定密钥')).toBeVisible();
    if (skipAfterRegistration) await page.getByRole('button', { name: '使用密钥解锁', exact: true }).click();
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
    await page.getByRole('textbox', { name: '笔记正文' }).fill('单把硬件保护的内容');
    await page.getByRole('button', { name: '锁定', exact: true }).click();
    const copyDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出副本', exact: true }).click();
    const copy = await copyDownload; const bytes = new Uint8Array(await readFile((await copy.path())!));
    expect(new TextDecoder().decode(bytes)).not.toContain('单把硬件保护的内容');
    const restored = new VaultSession({ crypto: webcrypto, hardware: nodeHardware(material), rpId: 'localhost' });
    restored.load(bytes); await restored.unlock(); expect(restored.listNotes()[0]?.body).toBe('单把硬件保护的内容');
    await page.getByRole('button', { name: '使用密钥解锁', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveValue('单把硬件保护的内容');
  });
}

test('Node 创建的文件在浏览器打开；失焦与迟到认证结果均不能泄露正文', async ({ page }) => {
  const material = await keys(); const bytes = await nodeVault(material); await installHardware(page, material); await page.goto('/app/');
  await page.getByRole('button', { name: '打开已有笔记库' }).click();
  await page.getByLabel('选择加密笔记库').setInputFiles({ name: 'Node.snote', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await page.getByRole('button', { name: '使用密钥解锁' }).click();
  await page.getByRole('button', { name: /Node 创建的笔记/ }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveValue('这份正文来自无 DOM 的 Node.js 核心。');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Node 创建的笔记');
  await page.evaluate(() => { (window as any).__hardwareTest.delay = true; });
  await page.getByRole('button', { name: '使用密钥解锁' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__hardwareTest.pending)).toBe(true);
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); (window as any).__hardwareTest.release(); });
  await expect(page.getByRole('heading', { name: '你的笔记已锁定' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Node 创建的笔记');
});

test('KeePassXC 形式的 PRF 通行密钥可创建、保存和重新打开笔记库', async ({ page }) => {
  await installHardware(page, await keys()); await page.goto('/app/');
  await page.evaluate(() => { (window as any).__hardwareTest.platformPasskey = true; });
  await page.getByRole('button', { name: '新建笔记库', exact: true }).click();
  await page.getByRole('button', { name: '登记主密钥', exact: true }).click();
  const verify = page.getByRole('button', { name: '验证主密钥', exact: true });
  const save = page.getByRole('button', { name: '选择位置并保存', exact: true });
  await expect(verify).toBeEnabled();

  await page.evaluate(() => { (window as any).__hardwareTest.noPrf = true; });
  await verify.click();
  await expect(page.getByRole('alert')).toContainText('未提供 WebAuthn PRF');
  await expect(save).toHaveCount(0);
  await page.evaluate(() => { (window as any).__hardwareTest.noPrf = false; });
  await verify.click();
  const created = page.waitForEvent('download'); await save.click(); await created;

  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill('通行密钥保护的笔记');
  await page.getByRole('textbox', { name: '笔记正文' }).fill('重新打开后可解密。');
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出副本', exact: true }).click();
  const download = await exported;
  const bytes = await readFile((await download.path())!);
  expect(bytes.toString()).not.toContain('重新打开后可解密。');

  await page.reload();
  await page.evaluate(() => { (window as any).__hardwareTest.platformPasskey = true; });
  await page.getByRole('button', { name: '打开已有笔记库', exact: true }).click();
  await page.getByLabel('选择加密笔记库').setInputFiles({ name: 'Notes.snote', mimeType: 'application/octet-stream', buffer: bytes });
  await page.getByRole('button', { name: '使用密钥解锁', exact: true }).click();
  await page.getByRole('button', { name: /通行密钥保护的笔记/ }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toHaveValue('重新打开后可解密。');
});

test('KeePassXC 未声明支持 PRF 时拒绝登记', async ({ page }) => {
  await installHardware(page, await keys()); await page.goto('/app/');
  await page.evaluate(() => { Object.assign((window as any).__hardwareTest, { platformPasskey: true, noPrf: true }); });
  await page.getByRole('button', { name: '新建笔记库' }).click();
  await page.getByRole('button', { name: '登记主密钥' }).click();
  await expect(page.getByRole('alert')).toContainText('未提供 WebAuthn PRF');
  await expect(page.getByRole('button', { name: '选择位置并保存' })).toHaveCount(0);
});

test('WebDAV 只上传密文，并以旧 ETag 阻止覆盖另一台设备版本', async ({ page }) => {
  const material = await keys(); let bytes = await nodeVault(material); let version = 1; let writes = 0; let conflict = false;
  await installHardware(page, material);
  await page.route('https://dav.invalid/Notes.snote', async route => {
    const request = route.request(); const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'authorization,content-type,cache-control,if-match,if-none-match', 'Access-Control-Expose-Headers': 'ETag', ETag: `"${version}"` };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === 'PUT') {
      if (request.headers()['if-match'] !== `"${version}"`) { conflict = true; await route.fulfill({ status: 412, headers }); return; }
      bytes = new Uint8Array(request.postDataBuffer()!); expect(new TextDecoder().decode(bytes)).not.toContain('远端私密内容');
      version++; writes++; await route.fulfill({ status: 204, headers: { ...headers, ETag: `"${version}"` } }); return;
    }
    await route.fulfill({ status: 200, body: Buffer.from(bytes), headers });
  });
  await page.goto('/app/'); await page.getByRole('button', { name: 'WebDAV', exact: true }).click();
  await page.getByLabel('加密文件 HTTPS 地址').fill('https://dav.invalid/Notes.snote');
  await page.getByLabel('用户名', { exact: true }).fill('test'); await page.getByLabel('应用密码', { exact: true }).fill('TEST_ONLY');
  await page.getByRole('checkbox', { name: /允许远端编辑/ }).check();
  await page.getByRole('button', { name: '打开已有笔记库' }).click();
  await page.getByRole('button', { name: '使用密钥解锁' }).click();
  await page.getByRole('button', { name: /Node 创建的笔记/ }).click();
  await page.getByRole('textbox', { name: '笔记正文' }).fill('远端私密内容');
  await page.getByRole('button', { name: '立即保存' }).click(); await expect.poll(() => writes).toBe(1);
  version++;
  await page.getByRole('textbox', { name: '笔记正文' }).fill('另一次修改');
  await page.getByRole('button', { name: '立即保存' }).click(); await expect.poll(() => conflict).toBe(true);
  await expect(page.getByText('检测到其他版本，已停止覆盖。')).toBeVisible(); expect(writes).toBe(1);
});

test('小屏幕首页没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/app/');
  await expect(page.getByRole('heading', { name: /把笔记留在/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('S3 在浏览器签名请求并通过条件 PUT 保存密文', async ({ page }) => {
  const material = await keys(); let bytes = await nodeVault(material); let writes = 0; let signed = false;
  await installHardware(page, material);
  await page.route('https://s3.invalid/**', async route => {
    const request = route.request(); const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'ETag', ETag: `"${writes + 1}"` };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': request.headers()['access-control-request-headers'] ?? 'authorization' } }); return; }
    signed = (request.headers()['authorization'] ?? '').startsWith('AWS4-HMAC-SHA256');
    if (request.method() === 'PUT') {
      expect(request.headers()['if-match']).toBe(`"${writes + 1}"`);
      expect(request.headers()['x-amz-security-token']).toBe('TEST_SESSION');
      bytes = new Uint8Array(request.postDataBuffer()!); expect(new TextDecoder().decode(bytes)).not.toContain('S3 浏览器私有内容');
      writes++; await route.fulfill({ status: 200, headers: { ...headers, ETag: `"${writes + 1}"` } }); return;
    }
    await route.fulfill({ status: 200, headers, body: Buffer.from(bytes) });
  });
  await page.goto('/app/'); await page.getByRole('button', { name: 'S3 存储', exact: true }).click();
  for (const [label, value] of [['HTTPS Endpoint', 'https://s3.invalid'], ['Region', 'us-east-1'], ['Bucket', 'notes'], ['Object Key', 'Notes.snote'], ['Access Key ID', 'TEST_ONLY'], ['Secret Access Key', 'TEST_ONLY'], ['Session Token（可选）', 'TEST_SESSION']]) {
    await page.getByLabel(label!, { exact: true }).fill(value!);
  }
  await page.getByRole('checkbox', { name: /允许远端编辑/ }).check(); await page.getByRole('button', { name: '打开已有笔记库' }).click();
  await page.getByRole('button', { name: '使用密钥解锁' }).click(); await page.getByRole('button', { name: /Node 创建的笔记/ }).click();
  await page.getByRole('textbox', { name: '笔记正文' }).fill('S3 浏览器私有内容'); await page.getByRole('button', { name: '立即保存' }).click();
  await expect.poll(() => writes).toBe(1); expect(signed).toBe(true);
});

test('前台空闲超时后隐藏全部内容', async ({ page }) => {
  const material = await keys(); const bytes = await nodeVault(material); await installHardware(page, material); await page.clock.install(); await page.goto('/app/');
  await page.getByRole('button', { name: '打开已有笔记库' }).click();
  await page.getByLabel('选择加密笔记库').setInputFiles({ name: 'Notes.snote', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await page.getByRole('button', { name: '使用密钥解锁' }).click(); await page.getByRole('button', { name: /Node 创建的笔记/ }).click();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('heading', { name: '你的笔记已锁定' })).toBeVisible(); await expect(page.locator('body')).not.toContainText('Node 创建的笔记');
});

test('PWA 只缓存静态资源，并可离线重新加载应用', async ({ page, context }) => {
  await page.goto('/app/');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe('/app/');
  await page.reload();
  const cached = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) { const cache = await caches.open(name); result.push(...(await cache.keys()).map(request => new URL(request.url).pathname)); }
    return result;
  });
  expect(cached).toContain('/app/');
  expect(cached).not.toContain('/');
  expect(cached).not.toContain('/zh/');
  expect(cached).not.toContain('/landing.css');
  expect(cached.some(name => name.endsWith('.snote'))).toBe(false);
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('heading', { name: /把笔记留在/ })).toBeVisible();
});

test('原生 WebAuthn 在 localhost 完成登记及 PRF 验证，不替换 credentials API', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: false,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  } });
  await page.goto('/app/');
  await page.getByRole('button', { name: '新建笔记库' }).click();
  await page.getByRole('button', { name: '登记主密钥' }).click();
  await expect(page.getByRole('button', { name: '验证主密钥', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验证主密钥', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择位置并保存', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登记备用密钥（可选）', exact: true })).toBeVisible();
  await cdp.detach();
});
