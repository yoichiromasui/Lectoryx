// =============================================================
// 演習の実行エンジン：学生の PC の公式 Julia（Lectoryx ローカル実行ツール runner/lectoryx-runner.jl）
//   ws://127.0.0.1:<port>/lectoryx/ws に接続し、最初のメッセージで合言葉（トークン）を送る。
//   ペアリング：実行ツールが開く URL（ライブラリ）の # 以降「lectoryx=<port>.<token>」を読み取り、端末に保存する
//   （# 以降はサーバに送られないので、合言葉が GitHub などに渡ることはない）。
//
//   state: 'unpaired'（ペアリングしていない） | 'connecting' | 'connected'
//          | 'unreachable'（実行ツールが起動していない・ブラウザが許可していない） | 'denied'（合言葉が違う）
//          | 'blocked'（ブラウザが https のページから 127.0.0.1 への接続を禁止している：Safari）
//          | 'unsupported'（iPad・iPhone。PC ではないので実行しない）
//
//   エンジンの約束（grader.js が使う。将来のブラウザ内の実行も同じ形にする）
//     run(code, { timeoutMs, env, onOutput }) → Result
//     runTests(code, tests, { timeoutMs, env, onProgress }) → { base: Result, results: [Result] }
//     ensureEnv({ name, project, manifest, warmup }, { onLog }) → 環境の鍵（run の env に渡す）
//     stop()
//   Result = { ok, output, value（value.js の共通形式）, display, error: { type, message, line }, timedOut, stopped, ms }
// =============================================================
const KEY = 'lectoryx.runner';
const PAIR_RE = /(?:^#|&)lectoryx=(\d+)\.([0-9a-f]{16,128})/;

/** URL の # 以降に lectoryx=<port>.<token> があれば保存して、アドレスバーから消す。保存したら true */
export function capturePairing() {
  const m = PAIR_RE.exec(location.hash);
  if (!m) return false;
  try { localStorage.setItem(KEY, JSON.stringify({ port: Number(m[1]), token: m[2] })); } catch { return false; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 何もしない */ }
  return true;
}

export function readPairing() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    return p && Number.isInteger(p.port) && typeof p.token === 'string' ? p : null;
  } catch { return null; }
}

export function forgetPairing() {
  try { localStorage.removeItem(KEY); } catch { /* 何もしない */ }
}

/** Safari 系（WebKit。iPad・iPhone はすべてのブラウザ） */
export function isSafariLike() {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
}

/** iPad・iPhone（演習は PC で実行する） */
export function isMobileApple() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

let seq = 0;
let shared = null;

/** 講義画面で共有するエンジン（最初に演習を開いたときに作る） */
export function getEngine() {
  if (!shared) shared = new NativeEngine(readPairing());
  return shared;
}

export class NativeEngine extends EventTarget {
  constructor(pairing) {
    super();
    this.id = 'native';
    this.label = 'PC の Julia';
    this.pairing = pairing;
    this.state = isMobileApple() ? 'unsupported' : pairing ? 'idle' : 'unpaired';
    this.info = null;
    this.ws = null;
    this.jobs = new Map();      // id → { onMessage, onClose }
    this.envs = new Map();      // 環境の名前 → { key, state, warn, log, waiters, onLog }
    this.current = null;        // 実行中の仕事の id（停止ボタン用）
  }

  get available() { return this.state === 'connected'; }

  _set(state, detail = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }

  /** 今の接続を捨てる（閉じたことによる状態の変化は起こさない） */
  _drop() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.abandoned = true;
    try { ws.close(); } catch { /* 何もしない */ }
    for (const [, j] of this.jobs) j.onClose?.();
    this.jobs.clear();
    this.envs.clear();
  }

  /** ペアリングを読み直す（ライブラリで新しくペアリングした後など） */
  refreshPairing() {
    if (this.state === 'unsupported') return;
    const p = readPairing();
    if (p && (!this.pairing || p.token !== this.pairing.token || p.port !== this.pairing.port)) {
      this.pairing = p;
      this._drop();
    }
  }

  /** ペアリングを解除する */
  unpair() {
    forgetPairing();
    this.pairing = null;
    this._drop();
    if (this.state !== 'unsupported') this._set('unpaired');
  }

  /** 接続する。成功すれば true */
  connect() {
    if (this.state === 'unsupported') return Promise.resolve(false);
    this.refreshPairing();
    if (!this.pairing) { this._set('unpaired'); return Promise.resolve(false); }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return this._ready || Promise.resolve(this.available);
    this._set('connecting');
    this._ready = new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${this.pairing.port}/lectoryx/ws`);
      } catch (err) {
        // Safari は https のページから ws://127.0.0.1 への接続をその場で拒否する（mixed content）
        this._set('blocked', { message: String(err?.message || err) });
        resolve(false);
        return;
      }
      this.ws = ws;
      let opened = false;
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'hello', token: this.pairing.token, client: 'lectoryx' }));
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'welcome') {
          this.info = m;
          this._set('connected', { info: m });
          done(true);
          return;
        }
        if (m.type === 'error' && m.code === 'auth') {
          this._set('denied', { message: m.message });
          done(false);
          return;
        }
        this._route(m);
      };
      const fail = () => {
        if (ws.abandoned) { done(false); return; }
        const was = this.state;
        if (this.ws === ws) this.ws = null;
        for (const [, j] of this.jobs) j.onClose?.();
        this.jobs.clear();
        this.envs.clear();
        if (was === 'denied') { done(false); return; }
        this._set(!opened && location.protocol === 'https:' && isSafariLike() ? 'blocked' : 'unreachable', { lost: was === 'connected' });
        done(false);
      };
      ws.onclose = fail;
      // WebKit は遮断したとき error だけで close を出さないことがあるので、つながる前の error も失敗として扱う
      ws.onerror = () => { if (!opened) { try { ws.close(); } catch { /* 何もしない */ } fail(); } };
    });
    return this._ready;
  }

  _route(m) {
    if (m.type === 'env-log' || m.type === 'env-status') {
      for (const [, e] of this.envs) {
        if (e.key !== m.env) continue;
        if (m.type === 'env-log') { e.log.push(m.text); e.onLog?.(m.text); }
        else { e.state = m.state; e.warn = m.warn; if (m.state !== 'installing') e.waiters.splice(0).forEach((f) => f(m)); }
      }
      if (m.type === 'env-status' && m.id && this.jobs.has(m.id)) this.jobs.get(m.id).onMessage(m);
      return;
    }
    const j = m.id && this.jobs.get(m.id);
    if (j) j.onMessage(m);
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('PC の Julia と接続していません');
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * 教材の環境を用意する。初回はパッケージのダウンロードと事前コンパイルで時間がかかる（以後はオフラインで使える）。
   * spec = { name, project, manifest, warmup }。onLog(text) で進み具合を受け取る。
   */
  async ensureEnv(spec, { onLog } = {}) {
    if (!spec) return 'base';
    const known = this.envs.get(spec.name);
    if (known && known.state === 'ready' && known.spec === spec) return known.key;
    const id = `env${++seq}`;
    const status = await new Promise((resolve, reject) => {
      this.jobs.set(id, {
        onMessage: (m) => {
          if (m.type === 'env-status') { this.jobs.delete(id); resolve(m); } else if (m.type === 'error') { this.jobs.delete(id); reject(new Error(m.message)); }
        },
        onClose: () => reject(new Error('PC の Julia との接続が切れました')),
      });
      try {
        this._send({ type: 'env', id, name: spec.name, project: spec.project || '', manifest: spec.manifest || '', warmup: spec.warmup || '' });
      } catch (err) { this.jobs.delete(id); reject(err); }
    });
    const e = { key: status.env, state: status.state, warn: status.warn, log: [], waiters: [], onLog, spec };
    this.envs.set(spec.name, e);
    if (status.state === 'installing') {
      const fin = await new Promise((resolve) => e.waiters.push(resolve));
      if (fin.state !== 'ready') throw new Error(`環境（${spec.name}）を用意できませんでした\n${e.log.slice(-8).join('\n')}`);
    } else if (status.state !== 'ready') {
      throw new Error(`環境（${spec.name}）を用意できませんでした`);
    }
    e.state = 'ready';
    return e.key;
  }

  /** コードを実行する（毎回まっさらな Julia）。onOutput(text) で出力を少しずつ受け取る */
  run(code, { timeoutMs = 10000, env = 'base', onOutput } = {}) {
    const id = `run${++seq}`;
    this.current = id;
    return new Promise((resolve) => {
      const finish = (r) => { this.jobs.delete(id); if (this.current === id) this.current = null; resolve(normalize(r)); };
      this.jobs.set(id, {
        onMessage: (m) => {
          if (m.type === 'output') onOutput?.(m.text);
          else if (m.type === 'result') finish(m);
          else if (m.type === 'error') finish({ ok: false, error: { type: 'runner', message: m.message } });
        },
        onClose: () => finish({ ok: false, error: { type: 'disconnected', message: 'PC の Julia との接続が切れました' } }),
      });
      try { this._send({ type: 'run', id, code, timeoutMs, env }); } catch (err) { finish({ ok: false, error: { type: 'disconnected', message: err.message } }); }
    });
  }

  /** 学生のコードの後にテストを順に実行する（1 つの Julia で。制限時間を超えたテストは止めて続ける） */
  runTests(code, tests, { timeoutMs = 5000, env = 'base', onProgress } = {}) {
    const id = `tests${++seq}`;
    this.current = id;
    return new Promise((resolve) => {
      let base = null;
      const results = [];
      const finish = () => {
        this.jobs.delete(id);
        if (this.current === id) this.current = null;
        resolve({ base: base || normalize({ ok: false, error: { message: '実行されませんでした' } }), results });
      };
      this.jobs.set(id, {
        onMessage: (m) => {
          if (m.type === 'base') { base = normalize(m); onProgress?.(0); }
          else if (m.type === 'test') { results[m.index - 1] = normalize(m); onProgress?.(m.index); }
          else if (m.type === 'tests-done') { if (m.error && !base) base = normalize(m); finish(); }
          else if (m.type === 'error') { base = base || normalize({ ok: false, error: { message: m.message } }); finish(); }
        },
        onClose: () => { base = base || normalize({ ok: false, error: { message: 'PC の Julia との接続が切れました' } }); finish(); },
      });
      try { this._send({ type: 'tests', id, code, tests, timeoutMs, env }); } catch (err) { base = normalize({ ok: false, error: { message: err.message } }); finish(); }
    });
  }

  /** 実行中のものを止める */
  stop() {
    if (this.current) try { this._send({ type: 'interrupt', id: this.current }); } catch { /* 何もしない */ }
  }
}

function normalize(m) {
  return {
    ok: !!m.ok,
    output: m.output || '',
    value: m.value,
    display: m.display || {},
    error: m.ok ? null : (m.error || { type: 'error', message: 'エラー' }),
    timedOut: !!m.timedOut,
    stopped: !!m.stopped,
    ms: m.ms ?? m.wall ?? null,
  };
}
