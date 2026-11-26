// =============================================================
// 教材の配信元と、端末に保存した教材の URL
//
//   配信元は 2 種類（ライブラリの ⋯ →「教材の配信元」で設定）
//   ・URL     ：catalog.json と教材ファイルが置かれた URL（既定 <アプリ>/lectures/。公開リポジトリの GitHub Pages など）
//   ・GitHub  ：非公開リポジトリの dist ブランチ（GitHub Actions が作る）。GitHub API から
//               読み取り専用のトークンで取得する。トークンはこの端末の中だけに保存し、
//               バックアップにも含めない。
//   保存した教材は <アプリ>/offline/<版>/<教材ルートからのパス>（sw.js が端末内から返す）。
// =============================================================
const KEY = 'lw.contentRoot';         // URL の配信元（既定から変えた場合）
const SRC_KEY = 'lw.contentSource';   // GitHub の配信元 { type:'github', repo, branch, token, api? }

export const APP_ROOT = new URL('../../', import.meta.url).href;
export const DEFAULT_CONTENT_ROOT = new URL('lectures/', APP_ROOT).href;
export const GITHUB_API = 'https://api.github.com';
export const DEFAULT_BRANCH = 'dist';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** URL を「/ で終わる http(s) の URL」に正規化（不正なら null） */
export function normalizeRoot(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u).trim(), APP_ROOT);
    if (!/^https?:$/.test(x.protocol)) return null;
    if (!x.pathname.endsWith('/')) x.pathname += '/';
    x.search = '';
    x.hash = '';
    return x.href;
  } catch {
    return null;
  }
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 無効 */ } }

/** URL の配信元（GitHub を使っていても、URL 側の設定値を返す） */
export function contentRoot() {
  return normalizeRoot(lsGet(KEY)) || DEFAULT_CONTENT_ROOT;
}

/**
 * 現在の配信元
 * @returns {{type:'url', url:string} | {type:'github', repo:string, branch:string, token:string, api:string}}
 */
export function getSource() {
  try {
    const j = JSON.parse(lsGet(SRC_KEY) || 'null');
    if (j && j.type === 'github' && REPO_RE.test(j.repo || '') && j.token) {
      return { type: 'github', repo: j.repo, branch: j.branch || DEFAULT_BRANCH, token: j.token, api: (j.api || GITHUB_API).replace(/\/+$/, '') };
    }
  } catch { /* 壊れた設定は無視 */ }
  return { type: 'url', url: contentRoot() };
}

/**
 * 配信元を設定する
 *   { type:'url', url }                        （url が空なら既定）
 *   { type:'github', repo, branch?, token? }    （token を省略すると保存済みのトークンを使う）
 */
export function setSource(src) {
  if (src.type === 'github') {
    const repo = String(src.repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!REPO_RE.test(repo)) throw new Error('リポジトリは「ユーザー名/リポジトリ名」の形で入力してください');
    const prev = getSource();
    const token = String(src.token || '').trim() || (prev.type === 'github' ? prev.token : '');
    if (!token) throw new Error('アクセストークンを入力してください');
    const branch = String(src.branch || '').trim() || DEFAULT_BRANCH;
    lsSet(SRC_KEY, JSON.stringify({ type: 'github', repo, branch, token, ...(src.api ? { api: src.api } : {}) }));
  } else {
    const n = normalizeRoot(src.url);
    if (src.url && !n) throw new Error('http:// または https:// で始まる URL を入力してください');
    lsSet(KEY, !n || n === DEFAULT_CONTENT_ROOT ? null : n);
    lsSet(SRC_KEY, null);
  }
  return getSource();
}

/** 設定済みのトークンを消す（GitHub の配信元をやめる） */
export function clearGithubSource() { lsSet(SRC_KEY, null); }

/** 配信元の識別子（教材一覧の控え・記録用。トークンは含まない） */
export function sourceKey(src = getSource()) {
  return src.type === 'github' ? `github:${src.repo}@${src.branch}` : src.url;
}

/** 表示・記録用（トークンを除く） */
export function publicSource(src = getSource()) {
  return src.type === 'github' ? { type: 'github', repo: src.repo, branch: src.branch } : { type: 'url', url: src.url };
}

/** 未ダウンロードの教材を配信元から直接開けるか（GitHub の非公開リポジトリは不可：先にダウンロードする） */
export const canOpenOnline = () => getSource().type === 'url';

export const offlineRoot = (version) => new URL(`offline/${version}/`, APP_ROOT).href;

/** 教材ルートからの相対パス（日本語のファイル名を含む）→ URL 用にエンコード */
export const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');
