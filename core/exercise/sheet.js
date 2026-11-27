// =============================================================
// 演習のシート：ページの上に重ねて、問題文・エディタ・実行・採点・出力・PC の Julia との接続を扱う
//   カード（card.js）の「開く」で読み込む。問題・期待値は exercises/<id>.json（tools/exercise.py が作る）。
//   書いたコードと採点の結果は、カードのあるページの state.exercises[id] に保存する（書き込みと同じく
//   講義の書き出し・全体バックアップに入る）。
//   実行エンジンがない端末（iPad、PC の Julia とつないでいない PC）では、問題とコードを見るだけになる。
// =============================================================
import { h } from '../util.js';
import { getEngine } from './native.js';
import { grade } from './grader.js';
import { attachEditor, inputHints, PASTE_MESSAGE } from './editor.js';

const RUNNER_ZIP = 'runner/lectoryx-runner.zip';
const RETRY_MS = 5000;           // 実行ツールが後から起動されたときのために、シートを開いている間だけ時々つなぎ直す
const RETRY_FOR_MS = 120000;

let active = null;

/** 開いているシート（テスト用） */
export function currentSheet() { return active; }

/**
 * @param {{ id, ex, lecture, paste: boolean, get(): rec, set(rec) }} o
 */
export function openExercise(o) {
  active?.close();
  active = new Sheet(o);
  return active;
}

class Sheet {
  constructor({ id, ex, lecture, paste, get, set }) {
    this.id = id;
    this.ex = ex;
    this.lecture = lecture;
    this.get = get;
    this.set = set;
    this.paste = paste;
    this.engine = getEngine();
    this.busy = false;
    this.envKey = null;
    this.saveTimer = 0;
    this.retryUntil = Date.now() + RETRY_FOR_MS;
    this.retryTimer = 0;
    this.build();
    this.onState = () => this.updateEngine();
    this.engine.addEventListener('state', this.onState);
    this.onFocus = () => this.reconnect();
    window.addEventListener('focus', this.onFocus);
    this.updateEngine();
    this.reconnect();
  }

  // ---------------------------------------------------------------- 画面
  build() {
    const ex = this.ex;
    const r = this.lecture.renderer;
    const btn = (label, cls, onclick, title) => h('button', { type: 'button', class: cls, onclick, title }, label);
    this.el = {};
    const e = this.el;
    e.chip = h('span', { class: 'lw-ex-engine' });
    e.code = h('textarea', {
      class: 'lw-ex-code', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off',
      'aria-label': 'Julia のコード', 'data-ink': 'off',
    });
    e.note = h('p', { class: 'lw-ex-pastenote', role: 'status', hidden: true });
    e.run = btn('▶ 実行', 'lw-ex-btn lw-ex-primary', () => this.run(), '実行（⌘Enter / Ctrl+Enter）');
    e.stop = btn('■ 停止', 'lw-ex-btn', () => this.engine.stop(), '実行を止める');
    e.grade = btn('✓ 採点', 'lw-ex-btn lw-ex-accent', () => this.grade(), 'テストで採点');
    e.uni = btn('\\α→α', 'lw-ex-btn lw-ex-mono', () => { e.code.focus(); this.editor.expand(); }, 'カーソルの前の \\alpha などを記号に変換（Tab キーでも）');
    e.reset = btn('⟲ ひな形', 'lw-ex-btn', () => this.resetCode(), 'ひな形に戻す');
    e.output = h('pre', { class: 'lw-ex-output' });
    e.runinfo = h('span', { class: 'lw-ex-muted' });
    e.score = h('span', { class: 'lw-ex-score' });
    e.tests = h('ol', { class: 'lw-ex-tests' });
    e.gradePanel = h('div', { class: 'lw-ex-panel', hidden: true }, h('div', { class: 'lw-ex-panel-head' }, '採点 ', e.score), e.tests);
    e.viewonly = h('p', { class: 'lw-ex-viewonly' });
    e.connbody = h('div', { class: 'lw-ex-connbody' });
    e.conn = h('details', { class: 'lw-ex-conn' }, h('summary', null, 'PC の Julia との接続'), e.connbody);
    const prompt = h('div', { class: 'lw-ex-prompt', html: r.md(ex.prompt || '') });
    const info = [];
    if (ex.env) info.push(`教材の環境：${ex.env.name}（初回だけパッケージの準備に数分かかります）`);
    if (!this.paste) info.push('ほかの場所からエディタへの貼り付けはできません（自分で入力します）。');
    this.root = h('div', { class: 'lw-ex-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `演習：${ex.title}`, 'data-ink': 'off' },
      h('header', { class: 'lw-ex-head' },
        h('span', { class: 'lw-ex-badge' }, 'Julia 演習'),
        h('h2', { class: 'lw-ex-title' }, ex.title),
        e.chip,
        btn('✕ 閉じる', 'lw-ex-btn lw-ex-close', () => this.close(), '閉じる（Esc）')),
      h('div', { class: 'lw-ex-body' },
        h('section', { class: 'lw-ex-left' },
          prompt,
          info.length ? h('p', { class: 'lw-ex-muted lw-ex-info' }, info.join(' ')) : null,
          h('div', { class: 'lw-ex-editor' }, e.code, e.note),
          h('div', { class: 'lw-ex-buttons' }, e.run, e.stop, e.grade, e.uni, h('span', { class: 'lw-ex-grow' }), e.reset),
          e.viewonly),
        h('section', { class: 'lw-ex-right' },
          h('div', { class: 'lw-ex-panel' }, h('div', { class: 'lw-ex-panel-head' }, '出力 ', e.runinfo), e.output),
          e.gradePanel,
          e.conn)));
    // 開いている間は、講義画面のキー操作（ページ送り・ツールの切り替え）に渡さない。Esc で閉じる
    // （実行中はボタンが無効になってフォーカスが外れるので、シートの外にフォーカスがあっても受け取る）
    this.onKey = (ev) => {
      if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); this.close(); return; }
      if (!this.root.contains(ev.target)) ev.stopPropagation();
    };
    window.addEventListener('keydown', this.onKey, true);
    this.root.addEventListener('keydown', (ev) => ev.stopPropagation());
    const saved = this.get();
    e.code.value = typeof saved?.code === 'string' ? saved.code : ex.template;
    this.editor = attachEditor(e.code, {
      paste: this.paste,
      onRun: () => this.run(),
      onBlocked: () => this.flashNote(PASTE_MESSAGE),
    });
    e.code.addEventListener('input', () => { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 500); });
    if (saved?.total) this.showScore(saved.passed, saved.total);
    document.body.appendChild(this.root);
    e.code.focus({ preventScroll: true });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.save();
    clearTimeout(this.retryTimer);
    clearTimeout(this.noteTimer);
    this.engine.removeEventListener('state', this.onState);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('keydown', this.onKey, true);
    if (this.busy) this.engine.stop();
    this.root.remove();
    if (active === this) active = null;
  }

  save() {
    clearTimeout(this.saveTimer);
    const code = this.el.code.value;
    const prev = this.get() || {};
    if (prev.code === code || (prev.code === undefined && code === this.ex.template)) return;
    this.set({ ...prev, code });
  }

  flashNote(text) {
    const n = this.el.note;
    n.textContent = text;
    n.hidden = false;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => { n.hidden = true; }, 5000);
  }

  resetCode() {
    const e = this.el;
    if (e.code.value === this.ex.template) return;
    const before = e.code.value;
    e.code.value = this.ex.template;
    this.save();
    e.runinfo.textContent = 'ひな形に戻しました ';
    e.runinfo.append(h('button', { type: 'button', class: 'lw-ex-link', onclick: () => { e.code.value = before; this.save(); e.runinfo.textContent = ''; } }, '元に戻す'));
  }

  // ---------------------------------------------------------------- 接続
  reconnect() {
    const en = this.engine;
    clearTimeout(this.retryTimer);
    if (this.closed || en.state === 'unsupported') return;
    en.refreshPairing();
    if (!en.available && en.state !== 'connecting') en.connect().then(() => this.scheduleRetry());
    else this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const en = this.engine;
    if (this.closed || en.available || !en.pairing || ['denied', 'blocked', 'unsupported'].includes(en.state) || Date.now() > this.retryUntil || document.hidden) return;
    this.retryTimer = setTimeout(() => this.reconnect(), RETRY_MS);
  }

  updateEngine() {
    const en = this.engine;
    const e = this.el;
    const s = en.state;
    const ok = en.available;
    const labels = {
      connected: [`PC の Julia ${en.info?.julia || ''}`, 'ready'],
      connecting: ['接続中…', 'busy'],
      idle: ['接続中…', 'busy'],
      unpaired: ['PC の Julia：未接続', 'off'],
      unreachable: ['PC の Julia：見つかりません', 'off'],
      denied: ['PC の Julia：合言葉が違います', 'error'],
      blocked: ['このブラウザでは実行できません', 'error'],
      unsupported: ['この端末では実行できません', 'off'],
    };
    const [text, cls] = labels[s] || [s, 'off'];
    e.chip.textContent = this.busy && ok ? '実行中…' : text;
    e.chip.className = `lw-ex-engine lw-ex-${this.busy && ok ? 'busy' : cls}`;
    e.run.disabled = this.busy || !ok;
    e.grade.disabled = this.busy || !ok || !this.ex.tests?.length;
    e.grade.hidden = !this.ex.tests?.length;
    e.stop.disabled = !this.busy;
    this.root.classList.toggle('lw-ex-noengine', !ok);
    e.viewonly.textContent = s === 'unsupported'
      ? 'この端末では Julia を実行できません。問題とコードは見られます（実行・採点は PC で行います）。'
      : 'PC の Julia とつなぐと、実行・採点できます（下の「PC の Julia との接続」）。';
    this.renderConn();
  }

  renderConn() {
    const en = this.engine;
    const s = en.state;
    const body = this.el.connbody;
    const port = en.pairing?.port || 27182;
    const zip = new URL(RUNNER_ZIP, document.baseURI).href;
    const how = () => h('ol', null,
      h('li', null, 'PC に Julia をインストールする（', h('a', { href: 'https://julialang.org/install/', target: '_blank', rel: 'noopener' }, 'julialang.org'), ' の juliaup。1 回だけ）'),
      h('li', null, h('a', { href: zip, download: '' }, 'Lectoryx ローカル実行ツール'), ' を保存して展開し、Windows は start-windows.cmd、Mac は start-mac.command をダブルクリック'),
      h('li', null, 'ブラウザでライブラリが開いて「PC の Julia とつなぎました」と出れば完了。Chrome・Edge では最初に「このデバイスのほかのアプリやサービスへのアクセス」を許可する'),
      h('li', null, 'この講義に戻って、もう一度演習を開く'));
    const retry = () => h('button', { type: 'button', class: 'lw-ex-btn', onclick: () => { this.retryUntil = Date.now() + RETRY_FOR_MS; this.reconnect(); } }, 'もう一度接続');
    const unpair = () => h('button', { type: 'button', class: 'lw-ex-btn', onclick: () => en.unpair() }, 'ペアリングを解除');
    let nodes = [];
    if (s === 'connected') {
      const i = en.info || {};
      nodes = [h('p', { class: 'lw-ex-ok' }, `接続しています：Julia ${i.julia}（実行ツール ${i.runner}）`),
        h('p', null, 'コードはこの PC の Julia で、毎回まっさらな状態から実行します。'), unpair()];
    } else if (s === 'unsupported') {
      nodes = [h('p', null, '演習のコードは PC（Windows・Mac）の Julia で実行します。この端末では問題とコードを見るだけです。')];
    } else if (s === 'unpaired') {
      nodes = [h('p', null, 'まだ PC の Julia とつないでいません。'), how()];
    } else if (s === 'connecting' || s === 'idle') {
      nodes = [h('p', null, '接続しています…')];
    } else if (s === 'unreachable') {
      nodes = [h('p', { class: 'lw-ex-ng' }, `PC の Julia（127.0.0.1:${port}）に接続できません。`),
        h('ul', null,
          h('li', null, 'Lectoryx ローカル実行ツールのウィンドウが開いているか確かめてください（閉じると使えません）。'),
          h('li', null, 'Chrome・Edge では、アドレスバーの左のアイコン →「サイトの設定」で、このデバイスのアプリへのアクセス（ローカル ネットワーク）を許可してください。')),
        retry(), how()];
    } else if (s === 'denied') {
      nodes = [h('p', { class: 'lw-ex-ng' }, '合言葉が違います。実行ツールのウィンドウに出ている「ペアリング用 URL」を開き直してください。'), unpair()];
    } else if (s === 'blocked') {
      nodes = [h('p', { class: 'lw-ex-ng' }, 'このブラウザ（Safari など）は、https のページから PC の Julia への接続を禁止しています。'),
        h('p', null, 'Chrome・Edge・Firefox でこの講義を開いてください。')];
    }
    body.replaceChildren(...nodes);
    if (['unpaired', 'unreachable', 'denied', 'blocked'].includes(s) && !this.connToggled) {
      this.el.conn.open = true;
      this.connToggled = true;
    }
  }

  // ---------------------------------------------------------------- 出力
  out(text, cls) {
    const s = h('span', { class: cls || null }, text);
    this.el.output.append(s);
    this.el.output.scrollTop = this.el.output.scrollHeight;
  }

  display(d) {
    if (!d) return;
    if (d['image/png'] || d['image/svg+xml']) {
      const src = d['image/png'] ? `data:image/png;base64,${d['image/png']}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d['image/svg+xml'])}`;
      this.el.output.append(h('img', { src, alt: '結果の図' }));
    } else if (d['text/plain']) {
      const t = this.el.output.textContent;
      this.out(`${t && !t.endsWith('\n') ? '\n' : ''}→ ${d['text/plain']}\n`, 'lw-ex-val');
    }
  }

  error(r, code) {
    const e = r.error || {};
    this.out(`${e.message || 'エラー'}${e.line ? `\n（${e.line} 行目）` : ''}\n`, 'lw-ex-err');
    for (const hint of inputHints(code)) this.out(`ヒント：${hint}\n`, 'lw-ex-note');
  }

  setBusy(b) {
    this.busy = b;
    this.updateEngine();
  }

  /** 教材の環境（Project.toml・Manifest.toml・warmup.jl）を用意する */
  async prepareEnv() {
    const spec = this.ex.env;
    if (!spec) return 'base';
    if (this.envKey) return this.envKey;
    let first = true;
    this.envKey = await this.engine.ensureEnv(spec, {
      onLog: (t) => {
        if (first) { this.out('初回なのでパッケージを準備しています（数分かかります。次からはオフラインですぐ使えます）\n', 'lw-ex-note'); first = false; }
        this.out(`${t}\n`, 'lw-ex-envlog');
      },
    });
    return this.envKey;
  }

  // ---------------------------------------------------------------- 実行・採点
  async run() {
    if (this.busy || !this.engine.available) return;
    this.save();
    this.setBusy(true);
    const e = this.el;
    e.output.textContent = '';
    e.runinfo.textContent = '実行中…';
    const code = e.code.value;
    try {
      const env = await this.prepareEnv();
      const t0 = performance.now();
      const r = await this.engine.run(code, { timeoutMs: Math.max(this.ex.timeLimitMs || 5000, 10000), env, onOutput: (t) => this.out(t) });
      if (r.ok) {
        this.display(r.display);
        if (!e.output.textContent.trim() && !e.output.querySelector('img')) this.out('（出力なし）\n', 'lw-ex-note');
      } else {
        this.error(r, code);
      }
      e.runinfo.textContent = r.stopped ? '止めました' : `${((performance.now() - t0) / 1000).toFixed(2)} 秒`;
    } catch (err) {
      this.out(`${err.message}\n`, 'lw-ex-err');
      e.runinfo.textContent = '';
    } finally {
      this.setBusy(false);
    }
  }

  showScore(passed, total) {
    const e = this.el;
    e.gradePanel.hidden = false;
    e.score.textContent = `${passed} / ${total}`;
    e.score.className = `lw-ex-score${passed === total ? ' lw-ex-all' : ''}`;
  }

  async grade() {
    const ex = this.ex;
    if (this.busy || !this.engine.available || !ex.tests?.length) return;
    this.save();
    this.setBusy(true);
    const e = this.el;
    e.gradePanel.hidden = false;
    e.score.textContent = '採点中…';
    e.score.className = 'lw-ex-score';
    e.output.textContent = '';
    const items = ex.tests.map((t) => {
      const li = h('li', { class: 'lw-ex-wait' }, h('span', { class: 'lw-ex-mark' }, '…'), t.name, h('span', { class: 'lw-ex-msg' }));
      return li;
    });
    e.tests.replaceChildren(...items);
    const t0 = performance.now();
    const code = e.code.value;
    try {
      const envKey = await this.prepareEnv();
      const rep = await grade(this.engine, { ...ex, envKey }, code, {
        onProgress: (i) => { const m = items[i]?.querySelector('.lw-ex-mark'); if (m) m.textContent = '▶'; },
      });
      rep.results.forEach((r, i) => {
        const li = items[i];
        li.className = r.pass ? 'lw-ex-pass' : 'lw-ex-fail';
        li.querySelector('.lw-ex-mark').textContent = r.pass ? '✓' : '✗';
        const msg = r.pass ? (r.kind === 'value' && r.actual ? `→ ${r.actual}` : '') : (r.message || '');
        li.querySelector('.lw-ex-msg').textContent = r.hidden && !r.pass ? '（非公開のテスト）' : msg;
      });
      this.showScore(rep.passed, rep.total);
      if (!rep.base.ok) this.error(rep.base, code);
      else if (rep.base.output) this.out(rep.base.output);
      e.runinfo.textContent = `採点 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
      this.set({ ...(this.get() || {}), code, passed: rep.passed, total: rep.total, at: Date.now() });
      this.lastReport = rep;
    } catch (err) {
      e.score.textContent = '採点できません';
      this.out(`${err.message}\n`, 'lw-ex-err');
    } finally {
      this.setBusy(false);
    }
  }
}
