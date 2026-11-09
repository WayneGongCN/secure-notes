import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_VAULT_BYTES, VaultError, VaultPersistence, VaultSession, asVaultError } from '@secure-notes/core';
import type { HardwareCredential, Note, PersistenceState, SessionState, VaultErrorCode, VaultStore } from '@secure-notes/core';
import { BrowserHardwareKeyProvider } from './platform/hardware';
import { ExportOnlyStore, downloadVault, newLocal, openLocal } from './platform/local-file';

type Kind = 'local' | 's3' | 'webdav';
type Screen = 'start' | 'create' | 'vault';
type Action = 'open' | 'new' | 'copy';
type Source = { kind: Kind | 'export'; label: string; persistence: VaultPersistence };
type Phase = 'primary-register' | 'primary-verify' | 'backup-register' | 'backup-verify' | 'ready';
const initialForm = { endpoint: '', region: 'us-east-1', bucket: '', key: 'Notes.snote', accessKeyId: '', secretAccessKey: '', sessionToken: '', url: '', username: '', password: '', verified: false, pathStyle: true };
const messages: Record<VaultErrorCode, string> = {
  INVALID_FORMAT: '文件格式无效、文件过大，或内容已损坏。', UNSUPPORTED_VERSION: '此笔记库由更新的版本创建，请先更新应用。', INVALID_INPUT: '请检查输入。新库至少需要完成主密钥的验证。',
  TAMPERED: '无法验证文件完整性或解封密钥。文件可能损坏，或硬件与此库不匹配。', WRONG_KEY: '请插入所选的硬件密钥，或切换到另一把已绑定的密钥。',
  LOCKED: '笔记库已锁定，请重新使用硬件解锁。', STALE_OPERATION: '操作所属的会话已结束。', CANCELLED: '操作已取消，笔记库保持锁定。',
  UNSUPPORTED: '当前浏览器或硬件不支持所需的 USB WebAuthn PRF 能力。', RP_MISMATCH: '请使用 localhost 或固定 HTTPS 域名，且与笔记库绑定的 RP ID 一致。',
  NOT_FOUND: '未找到笔记库。请检查文件位置，或选择新建。', CONFLICT: '保存位置已有不同版本，已停止覆盖。请导出当前副本，或重新打开远端版本。',
  READ_ONLY: '此位置暂不支持安全写入，可以读取和导出加密副本。', AUTH_FAILED: '认证失败或访问凭据已过期，请重新提供凭据。',
  PERMISSION_DENIED: '没有访问权限。请检查文件授权或存储账号权限。', NETWORK: '无法确认网络请求。请检查 HTTPS、网络和 CORS，并保留加密副本。',
  TIMEOUT: '网络请求超时。未确认保存的修改仍需上传或导出。', SAVE_FAILED: '未能确认保存完成，请重试或导出加密副本。',
};
const kindNames = { local: '本地文件', export: '文件导出模式', s3: 'S3 存储', webdav: 'WebDAV' };

/** 绘制不依赖外部图片资源的界面图标，喵~ */
function Icon({ name, size = 20 }: { name: 'lock' | 'key' | 'file' | 'cloud' | 'plus' | 'arrow' | 'download' | 'check' | 'trash'; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    key: <><circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-3-3 3-3m-6 0 3-3"/></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/></>,
    cloud: <path d="M7 18H6a4 4 0 1 1 .4-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9h-1M12 21V12m-3 3 3-3 3 3"/>,
    plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>, trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** 将内部保存状态映射为准确的产品文案，喵~ */
function saveLabel(source: Source | undefined, state: PersistenceState, exported: boolean, version: number): string {
  if (source?.kind === 'export') return exported ? '已导出 · 请保存到文件' : version ? '有修改待导出' : '文件导出模式';
  return ({ idle: '尚未保存', dirty: source?.kind === 'local' ? '待保存' : '待上传', saving: '正在保存', saved: '已保存', conflict: '存在版本冲突', error: '保存失败', 'read-only': '只读连接' })[state.status];
}

/** 维护 Web 交互及平台事件，所有业务与密码学操作通过核心包执行，喵~ */
export default function App() {
  const rpId = (import.meta.env.VITE_RP_ID as string | undefined) || location.hostname;
  const session = useMemo(() => new VaultSession({ crypto, hardware: new BrowserHardwareKeyProvider(), rpId }), [rpId]);
  const [state, setState] = useState<SessionState>(session.state);
  const [screen, setScreen] = useState<Screen>('start'); const [kind, setKind] = useState<Kind>('local');
  const [form, setForm] = useState(initialForm); const [phase, setPhase] = useState<Phase>('primary-register');
  const [pendingKey, setPendingKey] = useState<HardwareCredential>();
  const [source, setSource] = useState<Source>(); const sourceRef = useRef<Source | undefined>(undefined);
  const destination = useRef<{ store?: VaultStore; label: string; kind: Kind } | undefined>(undefined);
  const [saving, setSaving] = useState<PersistenceState>({ status: 'idle' }); const [exported, setExported] = useState(false);
  const exportedRef = useRef(false); exportedRef.current = exported;
  const [notes, setNotes] = useState<Note[]>([]); const [selected, setSelected] = useState<string>();
  const [credentialId, setCredentialId] = useState(''); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(false); const [idle, setIdle] = useState(60_000);
  const input = useRef<HTMLInputElement>(null); const actionEpoch = useRef(0);
  const observed = useRef({ vaultId: state.vaultId, version: state.contentVersion });

  /** 只展示稳定错误文案，不记录异常、连接地址和认证数据，喵~ */
  function showError(error: unknown): void {
    const code = asVaultError(error).code;
    if (code !== 'STALE_OPERATION') setMessage(messages[code]);
  }

  /** 绑定单一保存位置，连接凭据只随当前页面对象存在，喵~ */
  function attach(next: Source): void { sourceRef.current = next; setSource(next); setSaving(next.persistence.state); setExported(false); }

  /** 隔离迟到的连接或登记回调，关闭库后不允许旧任务替换界面，喵~ */
  async function run(task: (ticket: number) => Promise<void>): Promise<void> {
    const ticket = ++actionEpoch.current; setBusy(true); setMessage(''); setNotice('');
    try { await task(ticket); } catch (e) { if (ticket === actionEpoch.current) showError(e); }
    finally { if (ticket === actionEpoch.current) setBusy(false); }
  }

  /** 按用户明确配置创建远端适配器，不持久化任何账号凭据，喵~ */
  async function remoteStore(): Promise<{ store: VaultStore; label: string }> {
    if (kind === 's3') {
      const { S3Store } = await import('@secure-notes/core/storage/s3');
      return { store: new S3Store({ endpoint: form.endpoint, region: form.region, bucket: form.bucket, key: form.key, credentials: { accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey, sessionToken: form.sessionToken || undefined }, forcePathStyle: form.pathStyle, conditionalWritesVerified: form.verified }), label: `${form.bucket}/${form.key}` };
    }
    const { WebDavStore } = await import('@secure-notes/core/storage/webdav');
    return { store: new WebDavStore({ url: form.url, username: form.username, password: form.password, conditionalWritesVerified: form.verified }), label: 'WebDAV 加密库' };
  }

  /** 在解锁前读取和校验文件，打开失败时不替换当前活动保存位置，喵~ */
  async function openStore(store: VaultStore, label: string, type: Source['kind'], ticket: number): Promise<void> {
    const persistence = new VaultPersistence(store); const result = await persistence.open();
    if (ticket !== actionEpoch.current) return;
    session.load(result.bytes); attach({ kind: type, label, persistence });
    setCredentialId(session.credentials()[0]?.id ?? ''); setScreen('vault'); setSelected(undefined);
  }

  /** 打开、新建或复制当前笔记库，文件选择器只接触密文字节，喵~ */
  async function connect(action: Action): Promise<void> {
    await run(async ticket => {
      if (action === 'new') {
        const target = kind === 'local' ? { store: undefined, label: 'Notes.snote' } : await remoteStore();
        if (target.store?.conditionalWrite === 'none') throw new VaultError('READ_ONLY');
        if (ticket !== actionEpoch.current) return;
        session.reset(); sourceRef.current = undefined; setSource(undefined);
        destination.current = { ...target, kind }; setPhase('primary-register'); setPendingKey(undefined); setScreen('create'); return;
      }
      if (kind === 'local') {
        const store = action === 'open' ? await openLocal() : await newLocal();
        if (ticket !== actionEpoch.current) return;
        if (action === 'open') {
          if (!store) { input.current?.click(); return; }
          await openStore(store, store.handle.name, store.conditionalWrite === 'none' ? 'export' : 'local', ticket);
        } else {
          const bytes = await session.snapshot();
          if (store) { const persistence = new VaultPersistence(store); await persistence.create(bytes); if (ticket === actionEpoch.current) attach({ kind: 'local', label: store.handle.name, persistence }); }
          else { downloadVault(bytes); setNotice('已导出加密副本，请将文件保存到所需位置。'); }
          if (ticket === actionEpoch.current) setScreen('vault');
        }
        return;
      }
      const target = await remoteStore();
      if (action === 'open') await openStore(target.store, target.label, kind, ticket);
      else {
        const bytes = await session.snapshot(); const persistence = new VaultPersistence(target.store); await persistence.create(bytes);
        if (ticket === actionEpoch.current) { attach({ kind, label: target.label, persistence }); setScreen('vault'); }
      }
    });
  }

  /** 将至少完成主硬件验证的密文保存到用户指定位置，喵~ */
  async function finishCreation(): Promise<void> {
    await run(async ticket => {
      const target = destination.current; if (!target) throw new VaultError('INVALID_INPUT');
      const local = target.kind === 'local' ? await newLocal() : undefined;
      const bytes = await session.snapshot(); if (ticket !== actionEpoch.current) return;
      const store = target.store ?? local;
      if (store) {
        const persistence = new VaultPersistence(store); await persistence.create(bytes);
        if (ticket !== actionEpoch.current) return;
        attach({ kind: target.kind, label: local?.handle.name ?? target.label, persistence });
      } else {
        downloadVault(bytes); const persistence = new VaultPersistence(new ExportOnlyStore(bytes)); await persistence.open();
        attach({ kind: 'export', label: 'Notes.snote', persistence }); setExported(true);
      }
      destination.current = undefined; setPendingKey(undefined); setCredentialId(session.credentials()[0]?.id ?? ''); setScreen('vault');
    });
  }

  /** 根据显式用户操作登记验证主硬件，并按需配置备用硬件，喵~ */
  async function creationStep(): Promise<void> {
    await run(async ticket => {
      if (phase === 'primary-register' || phase === 'backup-register') {
        const next = await session.enroll(phase === 'primary-register' ? '主密钥' : '备用密钥');
        if (ticket === actionEpoch.current) { setPendingKey(next); setPhase(phase === 'primary-register' ? 'primary-verify' : 'backup-verify'); }
      } else if (phase === 'primary-verify') {
        if (!pendingKey) throw new VaultError('INVALID_INPUT'); await session.create(pendingKey);
        if (ticket === actionEpoch.current) { setPendingKey(undefined); setPhase('backup-register'); }
      } else if (phase === 'backup-verify') {
        if (!pendingKey) throw new VaultError('INVALID_INPUT');
        if (session.state.status !== 'unlocked') throw new VaultError('LOCKED');
        await session.addKey(pendingKey);
        if (ticket === actionEpoch.current) { setPendingKey(undefined); setPhase('ready'); }
      }
    });
  }

  /** 只将同一文档的已封存密文交给已捕获的保存位置，喵~ */
  async function save(): Promise<void> {
    const target = sourceRef.current; const vaultId = session.state.vaultId;
    if (!target) return;
    try {
      const bytes = await session.snapshot();
      if (sourceRef.current !== target || session.state.vaultId !== vaultId) return;
      if (target.kind === 'export') { downloadVault(bytes); setExported(true); return; }
      await target.persistence.save(bytes);
    } catch (e) { if (sourceRef.current === target) showError(e); }
  }

  /** 为不支持文件写回和断网场景提供独立加密副本，喵~ */
  async function exportCopy(): Promise<void> {
    try { downloadVault(await session.snapshot()); setNotice('已导出密文副本。下载完成后请保存到你的备份位置。'); if (sourceRef.current?.kind === 'export') setExported(true); }
    catch (e) { showError(e); }
  }

  /** 关闭当前库前提示未提交修改，随后清除会话及连接表单凭据，喵~ */
  function close(): void {
    const status = sourceRef.current?.persistence.state.status;
    if ((['dirty', 'saving', 'error', 'conflict'].includes(status ?? '') || (source?.kind === 'export' && !exported)) && !confirm('仍有修改未确认保存。请先导出密文副本；现在关闭将丢弃未保存内容。是否关闭？')) return;
    actionEpoch.current++; session.reset(); sourceRef.current = undefined; destination.current = undefined;
    setSource(undefined); setNotes([]); setPendingKey(undefined); setScreen('start'); setForm(initialForm); setBusy(false); setMessage(''); setNotice('');
  }

  /** 订阅核心状态并清除所有非解锁界面的明文副本，喵~ */
  useEffect(() => session.subscribe(next => {
    setState(next);
    if (next.status === 'unlocked') {
      try { setNotes(session.listNotes()); } catch { setNotes([]); }
      if (!document.hidden && document.hasFocus()) delete document.documentElement.dataset.shield;
    } else { setNotes([]); document.documentElement.dataset.shield = 'true'; }
    const prev = observed.current;
    if (next.vaultId === prev.vaultId && next.contentVersion > prev.version && next.canPersist && sourceRef.current) {
      sourceRef.current.persistence.markDirty(); setExported(false);
    }
    observed.current = { vaultId: next.vaultId, version: next.contentVersion };
  }), [session]);

  /** 订阅当前保存位置，旧位置的结果不得更新当前界面，喵~ */
  useEffect(() => {
    if (!source) return;
    setSaving(source.persistence.state);
    return source.persistence.subscribe(next => { if (sourceRef.current === source) setSaving(next); });
  }, [source]);

  /** 对加密快照进行防抖保存，锁定后的上传不需要重新持有解密密钥，喵~ */
  useEffect(() => {
    if (!source || !state.canPersist || source.kind === 'export' || !['dirty', 'saving'].includes(source.persistence.state.status)) return;
    const timer = setTimeout(() => { void save(); }, source.kind === 'local' ? 500 : 2000);
    return () => clearTimeout(timer);
  }, [source, state.snapshotVersion, state.canPersist]);

  /** 使用同步遮蔽和核心锁定处理窗口、后台及生命周期事件，喵~ */
  useEffect(() => {
    const lock = (): void => { document.documentElement.dataset.shield = 'true'; session.lock('background'); };
    /** 认证弹窗暂时失焦时保留请求，已解锁或隐藏页面仍立即锁定，喵~ */
    const blur = (): void => {
      document.documentElement.dataset.shield = 'true';
      if (document.hidden || session.state.status !== 'authenticating') session.lock('blur');
    };
    const visibility = (): void => { if (document.hidden) lock(); else session.checkIdle(); };
    const activity = (): void => session.touch();
    const key = (event: KeyboardEvent): void => {
      activity(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      if (event.key === 'Escape') session.lock('manual');
    };
    const unload = (event: BeforeUnloadEvent): void => {
      lock(); const status = sourceRef.current?.persistence.state.status;
      if (status && (['dirty', 'saving', 'error', 'conflict'].includes(status) || (sourceRef.current?.kind === 'export' && session.state.contentVersion > 0 && !exportedRef.current))) event.preventDefault();
    };
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', lock); window.addEventListener('pageshow', visibility); window.addEventListener('focus', visibility);
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', key); window.addEventListener('input', activity); window.addEventListener('wheel', activity, { passive: true });
    window.addEventListener('beforeunload', unload); const timer = setInterval(() => session.checkIdle(), 1000);
    return () => {
      clearInterval(timer); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', lock); window.removeEventListener('pageshow', visibility); window.removeEventListener('focus', visibility);
      window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', key); window.removeEventListener('input', activity); window.removeEventListener('wheel', activity); window.removeEventListener('beforeunload', unload);
    };
  }, [session]);

  const active = notes.find(n => n.id === selected);
  const remoteReadOnly = source && source.kind !== 'local' && source.kind !== 'export' && saving.status === 'read-only';
  const isUnlocked = state.status === 'unlocked';
  const canFinishCreation = phase === 'backup-register' || phase === 'ready';
  const setupLocked = state.status === 'locked' && state.keyLabels.length === 1;

  /** 新建空白笔记，核心确认封存后再选中，喵~ */
  async function addNote(): Promise<void> {
    try { const note = await session.addNote(); if (session.state.status === 'unlocked') setSelected(note.id); } catch (e) { showError(e); }
  }

  /** 将编辑器变更直接送入核心，不在 UI 另外维护业务副本，喵~ */
  function editNote(id: string, title: string, body: string): void { void session.updateNote(id, { title, body }).catch(showError); }

  /** 显式确认后删除当前版本的笔记，喵~ */
  async function deleteNote(): Promise<void> {
    if (!active || !confirm('删除这篇笔记？历史备份中的内容不会随之删除。')) return;
    try { await session.deleteNote(active.id); setSelected(undefined); } catch (e) { showError(e); }
  }

  /** 渲染连接字段，凭据不写入 URL、持久存储或文件，喵~ */
  function field(name: keyof typeof initialForm, label: string, placeholder = '', secret = false) {
    return <label className="field" key={name}><span>{label}</span><input value={String(form[name])} onChange={event => setForm(prev => ({ ...prev, [name]: event.target.value }))} type={secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={placeholder}/></label>;
  }

  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="#" onClick={event => { event.preventDefault(); if (screen === 'start' && source) setScreen('vault'); }}><span className="brand-mark"><Icon name="lock" size={21}/></span><span>Secure Notes<span className="brand-caption">私有笔记</span></span></a><span className="privacy-badge"><span className="status-dot"/>客户端加密<span className="desktop-only"> · 数据由你保管</span></span></header>
    {(message || notice) && <div className={`message ${message ? 'error' : ''}`} role={message ? 'alert' : 'status'}><span>{message || notice}</span><button className="text-button" onClick={() => { setMessage(''); setNotice(''); }} aria-label="关闭提示">×</button></div>}
    <input ref={input} className="file-input" type="file" accept=".snote,application/octet-stream" aria-label="选择加密笔记库" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) void run(async ticket => { if (file.size > MAX_VAULT_BYTES) throw new VaultError('INVALID_FORMAT'); await openStore(new ExportOnlyStore(new Uint8Array(await file.arrayBuffer())), file.name, 'export', ticket); });
    }}/>

    {screen === 'start' && <main className="welcome"><section className="intro"><p className="eyebrow">一个文件，一把属于你的钥匙</p><h1>把笔记留在<br/><span>自己手里。</span></h1><p className="intro-copy">写下重要的事。内容在设备上加密，<br/>只有你的实体硬件密钥能够打开。</p><div className="principles"><span><Icon name="key" size={17}/>硬件解锁</span><span><Icon name="lock" size={17}/>失焦锁定</span><span><Icon name="file" size={17}/>自由迁移</span></div><p className="quiet-note">无账号系统 · 无分析追踪 · 不上传明文</p></section>
      <section className="connect-card"><div className="section-label">笔记库</div><h2>{source ? '另存到其他位置' : '选择你的保存位置'}</h2><p className="subtle">同一个加密文件，三种保存方式。</p><div className="storage-options" role="group" aria-label="存储方式">{(['local', 's3', 'webdav'] as const).map(type => <button key={type} className={`storage-option ${kind === type ? 'selected' : ''}`} onClick={() => setKind(type)} aria-pressed={kind === type}><Icon name={type === 'local' ? 'file' : 'cloud'} size={23}/><span>{kindNames[type]}</span>{kind === type && <span className="option-check"><Icon name="check" size={12}/></span>}</button>)}</div>
        {kind === 'local' ? <div className="local-description"><Icon name="file" size={31}/><div><strong>文件保存在你的设备或同步目录</strong><p>支持时直接保存原文件；Safari / iOS 通过导出新版文件保存。浏览器数据被清理也不会删除已保存的文件。</p></div></div> : <div className="connection-fields">
          {kind === 's3' ? <>{field('endpoint', 'HTTPS Endpoint', 'https://s3.example.com')}<div className="field-grid">{field('region', 'Region', 'us-east-1')}{field('bucket', 'Bucket', 'private-notes')}</div>{field('key', 'Object Key', 'Notes.snote')}<div className="field-grid">{field('accessKeyId', 'Access Key ID', '', true)}{field('secretAccessKey', 'Secret Access Key', '', true)}</div>{field('sessionToken', 'Session Token（可选）', '', true)}<label className="checkbox"><input type="checkbox" checked={form.pathStyle} onChange={e => setForm(prev => ({ ...prev, pathStyle: e.target.checked }))}/>使用路径式地址（S3 兼容服务）</label></> : <>{field('url', '加密文件 HTTPS 地址', 'https://dav.example.com/notes/Notes.snote')}<div className="field-grid">{field('username', '用户名')}{field('password', '应用密码', '', true)}</div></>}
          <label className="checkbox"><input type="checkbox" checked={form.verified} onChange={e => setForm(prev => ({ ...prev, verified: e.target.checked }))}/>允许远端编辑：已在测试库验证版本条件写入</label><details><summary>连接与安全要求</summary><p>凭据只记住到关闭页面。服务需允许当前站点 <code>{location.origin}</code> 的跨域 GET/PUT，暴露 ETag，并正确执行 If-Match / If-None-Match。未启用远端编辑时仅可读取、导出。</p></details>
        </div>}
        <div className="connect-actions">{source ? <><button className="button primary" disabled={busy} onClick={() => void connect('copy')}>另存加密副本<Icon name="arrow" size={17}/></button><button className="button secondary" onClick={() => setScreen('vault')}>返回笔记库</button></> : <><button className="button primary" disabled={busy} onClick={() => void connect('open')}>{busy ? '正在连接…' : '打开已有笔记库'}<Icon name="arrow" size={17}/></button><button className="button secondary" disabled={busy} onClick={() => void connect('new')}><Icon name="plus" size={17}/>新建笔记库</button></>}</div><p className="card-footnote"><Icon name="lock" size={13}/>内容始终先加密，再写入保存位置。</p>
      </section></main>}

    {screen === 'create' && <main className="center-stage"><section className="setup-card">
      <span className="large-icon"><Icon name="key" size={32}/></span><p className="eyebrow">建立你的私有空间</p><h1>绑定你的实体密钥</h1><p className="subtle">主密钥验证后即可创建。备用密钥可选，绑定后也能独立解锁。</p>
      <div className="setup-progress"><span className={state.keyLabels.length >= 1 ? 'complete' : 'current'}><Icon name={state.keyLabels.length >= 1 ? 'check' : 'key'}/>主密钥</span><span className={state.keyLabels.length >= 2 ? 'complete' : ''}><Icon name={state.keyLabels.length >= 2 ? 'check' : 'key'}/>备用密钥（可选）</span></div>
      <p className="step-hint">{setupLocked ? '会话已锁定。已验证的笔记库仍可保存；配置备用密钥前需重新验证主密钥。' : ({ 'primary-register': '插入主 USB 密钥，设置或输入其 FIDO2 PIN。', 'primary-verify': '再次使用主密钥，验证它确实能够派生加密密钥。', 'backup-register': '主密钥已验证，可以直接保存。也可拔出主密钥，配置另一把 USB 密钥作为备用。', 'backup-verify': '再次使用备用密钥，验证独立恢复能力；也可跳过，仅保存主密钥。', ready: '两把密钥已验证。现在保存你的第一个加密笔记库。' })[phase]}</p>
      <div className="connect-actions">
        <button className="button primary" disabled={busy} onClick={() => void (canFinishCreation ? finishCreation() : setupLocked ? run(async () => { await session.unlock(); }) : creationStep())}>{busy ? '正在处理…' : canFinishCreation ? '选择位置并保存' : setupLocked ? '重新验证主密钥' : ({ 'primary-register': '登记主密钥', 'primary-verify': '验证主密钥', 'backup-register': '登记备用密钥（可选）', 'backup-verify': '验证备用密钥', ready: '选择位置并保存' })[phase]}<Icon name="arrow" size={17}/></button>
        {phase === 'backup-register' && <button className="button secondary" disabled={busy} onClick={() => void (setupLocked ? run(async () => { await session.unlock(); }) : creationStep())}>{setupLocked ? '重新验证主密钥以配置备用密钥' : '登记备用密钥（可选）'}</button>}
        {phase === 'backup-verify' && <button className="button secondary" disabled={busy} onClick={() => void finishCreation()}>跳过备用密钥并保存</button>}
      </div>
      {state.keyLabels.length === 1 && <p className="card-footnote">仅绑定一把密钥时，密钥丢失或损坏后将无法解密笔记。</p>}
      <button className="text-button cancel-setup" onClick={close}>取消创建</button><p className="card-footnote">需要支持 WebAuthn PRF 的 USB FIDO2 密钥。PIN 由浏览器处理。</p></section></main>}

    {screen === 'vault' && <main className={`vault ${selected ? 'has-selection' : ''}`}><aside className="sidebar"><div className="vault-location"><span className="section-label">当前笔记库</span><strong className={isUnlocked ? 'sensitive' : ''} title={isUnlocked ? source?.label : undefined}>{isUnlocked ? source?.label ?? '加密笔记库' : '加密笔记库'}</strong><span className="location-caption">{source && kindNames[source.kind]}<span className="separator">/</span>{state.keyLabels.length} 把硬件密钥</span></div><div className="notes-heading"><h2>笔记{isUnlocked && <span className="sensitive">{notes.length}</span>}</h2><button className="icon-button" aria-label="新建笔记" disabled={!isUnlocked || !!remoteReadOnly} onClick={() => void addNote()}><Icon name="plus"/></button></div>
      {isUnlocked ? <div className="note-list sensitive">{notes.map(note => <button key={note.id} className={`note-item ${selected === note.id ? 'active' : ''}`} onClick={() => setSelected(note.id)}><strong>{note.title || '未命名笔记'}</strong><p>{note.body.trim().split('\n')[0] || '写下第一句话…'}</p><time>{new Date(note.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</time></button>)}{!notes.length && <p className="empty-list">还没有笔记。<br/>点击 + 开始记录。</p>}</div> : <div className="locked-list"><Icon name="lock"/><span>解锁后查看笔记</span></div>}
      <div className="sidebar-bottom"><button className="plain-row" onClick={() => { session.lock('switch-location'); setScreen('start'); }}><Icon name="cloud" size={16}/>另存到其他位置</button><button className="plain-row" onClick={close}><Icon name="file" size={16}/>关闭笔记库</button></div></aside>
      <section className="workspace"><div className="workspace-toolbar"><span className={`save-status ${saving.status}`} role="status"><span className="status-dot"/>{saveLabel(source, saving, exported, state.contentVersion)}</span><div className="toolbar-actions"><button className="text-button" onClick={() => void exportCopy()} disabled={!state.canPersist}><Icon name="download" size={16}/><span className="desktop-only">导出副本</span></button><button className="text-button" onClick={() => setSettings(!settings)} aria-expanded={settings}>设置</button>{isUnlocked && <button className="button small secondary" onClick={() => session.lock('manual')}><Icon name="lock" size={14}/>锁定</button>}</div></div>
      {settings && <div className="settings-panel"><label>空闲自动锁定<select aria-label="空闲自动锁定" value={idle} onChange={e => { const ms = Number(e.target.value); setIdle(ms); session.setIdleTimeout(ms); }}><option value="30000">30 秒</option><option value="60000">1 分钟</option><option value="300000">5 分钟</option></select></label><p>切换窗口、进入后台会立即锁定。Web 页面无法可靠禁止系统截图。解锁后允许拔出密钥。</p><code>RP ID: {rpId}</code></div>}
      {saving.status === 'conflict' && <div className="conflict-banner" role="alert"><strong>检测到其他版本，已停止覆盖。</strong><span>请先导出当前副本，再重新打开存储中的版本。</span><button className="text-button" onClick={() => void exportCopy()}>导出当前副本</button><button className="text-button" onClick={() => { if (source && confirm('重新打开会丢弃当前未保存修改，是否继续？')) void run(async ticket => openStore(source.persistence.store, source.label, source.kind, ticket)); }}>重新打开</button></div>}
      {!isUnlocked ? <div className="lock-screen"><span className="lock-orbit"><Icon name="lock" size={40}/></span><p className="eyebrow">安全会话已关闭</p><h1>{state.status === 'authenticating' ? '等待硬件密钥' : '你的笔记已锁定'}</h1><p>标题和内容均已隐藏。<br/>插入 USB 密钥，完成浏览器认证后继续。</p><label className="key-select"><span>选择解锁密钥</span><select value={credentialId} onChange={e => setCredentialId(e.target.value)}>{session.credentials().map(key => <option value={key.id} key={key.id}>{key.label}</option>)}</select></label><button className="button primary" disabled={busy || state.status === 'authenticating'} onClick={() => void run(async () => { await session.unlock(credentialId); })}><Icon name="key" size={18}/>{state.status === 'authenticating' ? '请完成硬件认证…' : '使用硬件密钥解锁'}</button><p className="lock-footnote">存储连接保留在本页内存中，解密会话已清除。</p></div> : active ? <article className="editor sensitive"><div className="editor-top"><button className="text-button mobile-only" onClick={() => setSelected(undefined)}>← 笔记列表</button><time>{new Date(active.updatedAt).toLocaleString('zh-CN')}</time><button className="icon-button danger" aria-label="删除笔记" disabled={!!remoteReadOnly} onClick={() => void deleteNote()}><Icon name="trash" size={17}/></button></div><input className="note-title" autoComplete="off" autoCorrect="off" spellCheck={false} aria-label="笔记标题" placeholder="未命名笔记" value={active.title} maxLength={200} disabled={!!remoteReadOnly} onChange={e => editNote(active.id, e.target.value, active.body)}/><textarea className="note-body" autoComplete="off" autoCorrect="off" aria-label="笔记正文" placeholder="从这里开始写…" value={active.body} maxLength={1024 * 1024} disabled={!!remoteReadOnly} spellCheck={false} onChange={e => editNote(active.id, active.title, e.target.value)}/><div className="editor-footer"><span>{remoteReadOnly ? '当前连接只读，可导出副本' : '纯文本 · 客户端加密'}</span><span>{active.body.length.toLocaleString()} 字符</span><button className="text-button" disabled={!!remoteReadOnly} onClick={() => void save()}>{source?.kind === 'export' ? '导出保存' : '立即保存'}</button></div></article> : <div className="empty-editor"><span className="large-icon"><Icon name="file" size={31}/></span><h2>给重要的事，留一个位置。</h2><p>选择一篇笔记，或从一张空白纸开始。</p><button className="button secondary" disabled={!!remoteReadOnly} onClick={() => void addNote()}><Icon name="plus" size={17}/>新建笔记</button></div>}
      </section></main>}
    <footer className="app-footer"><span>SECURE BY DESIGN</span><span>只有密文离开设备。请独立保管备用密钥与备份。</span></footer>
  </div>;
}
