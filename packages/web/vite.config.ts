import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [{
    name: 'secure-notes-offline',
    /** 开发热更新需要动态样式；严格 CSP 仅用于生产构建，喵~ */
    transformIndexHtml(html, context) {
      return context.server ? html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '') : html;
    },
    /** 只预缓存已知静态构建产物，不缓存笔记、API 响应或凭据，喵~ */
    generateBundle(_options, bundle) {
      const assets = [...new Set(['/', '/index.html', '/icon.svg', '/manifest.webmanifest', ...Object.keys(bundle).map(name => `/${name}`)])];
      const hash = createHash('sha256').update(JSON.stringify(assets));
      for (const item of Object.values(bundle)) hash.update(item.type === 'chunk' ? item.code : item.source);
      for (const file of ['./index.html', './public/icon.svg', './public/manifest.webmanifest']) hash.update(readFileSync(new URL(file, import.meta.url)));
      const version = hash.digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `const CACHE='secure-notes-${version}';\nconst ASSETS=${JSON.stringify(assets)};\nself.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));\nself.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('secure-notes-')&&key!==CACHE).map(key=>caches.delete(key))))));\nself.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method==='GET'&&url.origin===self.location.origin&&ASSETS.includes(url.pathname)&&!url.search){event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname,{ignoreVary:true})).then(hit=>hit||fetch(event.request)));}});\n` });
    },
  }],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
});
