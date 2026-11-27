// =============================================================
// 講義ファイル（lecture.md）の解析と HTML 化
//
//   ---              ← ファイル先頭のフロントマター（YAML の簡易サブセット）
//   title: ...
//   ---
//   本文 ...
//   ---              ← ページ区切り（行全体が --- ）
//   @page id=ode     ← ページ属性
//   # 見出し
//   $$ 数式 $$
//   ::: def タイトル ← コンテナ（::: で閉じる。入れ子可）
//   :::
//   @widget name k=v ← 1 行ディレクティブ
//
// 書式の詳細は CLAUDE.md「教材の書き方」を参照。
// =============================================================
import { Marked } from '../../vendor/marked/marked.esm.js';
import { escapeHtml } from '../util.js';

// ---------------------------------------------------------------
// フロントマター（YAML の簡易サブセット）
//   key: value / key: (改行) + インデントした "subkey: value" または "- item"
// ---------------------------------------------------------------
export function parseFrontMatter(src) {
  const out = {};
  let parent = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const indented = /^\s/.test(raw);
    if (indented && parent) {
      if (line.startsWith('- ')) {
        if (!Array.isArray(out[parent])) out[parent] = [];
        out[parent].push(scalar(line.slice(2).trim()));
      } else {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        if (!out[parent] || typeof out[parent] !== 'object' || Array.isArray(out[parent])) out[parent] = {};
        out[parent][line.slice(0, i).trim()] = scalar(line.slice(i + 1).trim());
      }
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (value === '') { parent = key; out[key] = null; }
    else { parent = null; out[key] = scalar(value); }
  }
  return out;
}

function scalar(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// ---------------------------------------------------------------
// ディレクティブ引数:  name a=1 b="x y" flag  →  { _: ['name','flag'], a: 1, b: 'x y' }
// ---------------------------------------------------------------
export function parseArgs(str) {
  const out = { _: [] };
  const re = /([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) {
    if (m[1]) {
      const v = m[2] ?? m[3] ?? m[4];
      out[m[1]] = m[4] !== undefined ? scalar(v) : v;
    } else {
      out._.push(m[5] ?? m[6] ?? m[7]);
    }
  }
  return out;
}

// ---------------------------------------------------------------
// 講義ファイル全体 → { meta, pages:[{id, opts, title, src}] }
// ---------------------------------------------------------------
export function parseLecture(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let meta = {};
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (fm) {
    meta = parseFrontMatter(fm[1]);
    text = text.slice(fm[0].length);
  }

  const chunks = splitPages(text);
  const pages = [];
  for (const chunk of chunks) {
    const opts = {};
    const lines = [];
    let fence = null;
    let pdf = null;
    for (const line of chunk.split('\n')) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1];
      const m = !fence && /^@page\b(.*)$/.exec(line);
      const mp = !fence && /^@pdf\b(.*)$/.exec(line);
      if (m) {
        const a = parseArgs(m[1]);
        for (const x of a._) opts[x] = true; // 値なしの語はフラグ扱い
        delete a._;
        Object.assign(opts, a);
      } else if (mp) {
        pdf = parseArgs(mp[1]); // PDF のページ群に展開される（content/lecture.js）
      } else {
        lines.push(line);
      }
    }
    const src = lines.join('\n');
    if (pdf) {
      if (src.replace(/<!--[\s\S]*?-->/g, '').trim()) console.warn('[lecture] @pdf のページに書いた本文は無視されます');
      pages.push({ opts, src: '', title: '', pdf });
      continue;
    }
    if (!src.trim() && Object.keys(opts).length === 0) continue;
    pages.push({ opts, src, title: opts.title ? String(opts.title) : firstHeading(src) });
  }

  // ページ ID：明示指定 > 最初の見出し > 連番（@pdf は読み込み時に「接頭辞-ページ番号」）
  const used = new Set();
  pages.forEach((p, idx) => {
    if (p.pdf) return;
    let id = p.opts.id != null ? String(p.opts.id) : (p.title ? 'h:' + p.title : `p${idx + 1}`);
    if (used.has(id)) {
      if (p.opts.id != null) console.warn(`[lecture] ページID "${id}" が重複しています`);
      let k = 2;
      while (used.has(`${id}~${k}`)) k++;
      id = `${id}~${k}`;
    }
    used.add(id);
    p.id = id;
  });
  return { meta, pages };
}

function splitPages(text) {
  const out = [];
  let cur = [];
  let fence = null;
  let inMath = false;
  for (const line of text.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f && !inMath) fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1];
    else if (!fence && (line.match(/\$\$/g) || []).length % 2 === 1) inMath = !inMath;
    if (!fence && !inMath && /^---\s*$/.test(line)) {
      out.push(cur.join('\n'));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  out.push(cur.join('\n'));
  return out;
}

function firstHeading(src) {
  let fence = null;
  for (const line of src.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { fence = fence ? null : f[1]; continue; }
    if (fence) continue;
    const m = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1];
  }
  return '';
}

// ---------------------------------------------------------------
// レンダラ（講義ごとに 1 つ。KaTeX マクロを共有する）
// ---------------------------------------------------------------
const BOX_LABELS = {
  box: '', def: '定義', thm: '定理', prop: '性質', lemma: '補題', cor: '系',
  ex: '例', exer: '演習', q: '問', ans: '解答', note: '注意', point: 'ポイント',
};

export function createRenderer({ macros = {} } = {}) {
  const katex = globalThis.katex;
  const marked = new Marked({ gfm: true, breaks: true });
  const katexMacros = {};
  for (const [k, v] of Object.entries(macros || {})) katexMacros[k] = String(v);

  /** TeX 文字列 → HTML */
  function tex(src, display = false) {
    if (!katex) return `<code>${escapeHtml(src)}</code>`;
    return katex.renderToString(src, {
      displayMode: display, throwOnError: false, output: 'html',
      macros: katexMacros, strict: false, trust: false,
    });
  }

  /** 数式を退避してから marked に渡し、最後に KaTeX の出力へ置き換える */
  function withMath(src, fn) {
    const store = [];
    const text = protectMath(src, (body, display) => {
      store.push({ body, display });
      return display ? `LWDMATH${store.length - 1}X` : `LWMATH${store.length - 1}X`;
    });
    let html = fn(text);
    if (!store.length) return html;
    html = html
      .replace(/<p>\s*(LWDMATH\d+X)\s*<\/p>/g, '<div class="lw-math">$1</div>')
      .replace(/(?:<br>\s*)?(LWDMATH\d+X)(?:\s*<br>)?/g, '$1');
    return html.replace(/LW(D?)MATH(\d+)X/g, (_, d, k) => tex(store[+k].body, store[+k].display));
  }

  /** Markdown（ブロック） → HTML */
  function md(src) { return withMath(src, (t) => marked.parse(t)); }

  /** 1 行テキスト（ラベル等）→ HTML。$...$ と **強調** などのインライン記法のみ */
  function inline(src) { return withMath(String(src ?? ''), (t) => marked.parseInline(t)); }

  /** ページ本文（ディレクティブ・コンテナを含む）→ HTML */
  function page(src) { return renderBlocks(src.split('\n')); }

  // ---- ブロック解析 ----
  function renderBlocks(lines) {
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(md(buf.join('\n'))); buf = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        const j = findFenceEnd(lines, i, f[1]);
        buf.push(...lines.slice(i, j + 1));
        i = j;
        continue;
      }
      if ((line.match(/\$\$/g) || []).length % 2 === 1) {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes('$$')) j++;
        buf.push(...lines.slice(i, Math.min(j, lines.length - 1) + 1));
        i = j;
        continue;
      }
      let m = /^\s*:::+\s*([A-Za-z][\w-]*)\s*(.*)$/.exec(line);
      if (m) {
        const j = findContainerEnd(lines, i);
        flush();
        out.push(container(m[1], m[2].trim(), renderBlocks(lines.slice(i + 1, j))));
        i = j;
        continue;
      }
      if (/^\s*:::+\s*$/.test(line)) continue; // 対応のない閉じ
      m = /^@([A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(line);
      if (m) {
        flush();
        out.push(directive(m[1], m[2] || ''));
        continue;
      }
      buf.push(line);
    }
    flush();
    return out.join('\n');
  }

  function container(name, args, inner) {
    if (name in BOX_LABELS) {
      const label = BOX_LABELS[name];
      const title = (label ? `<span class="lw-box-label">${label}</span>` : '') + (args ? ' ' + inline(args) : '');
      return `<div class="lw-box lw-box-${name}">${title.trim() ? `<div class="lw-box-title">${title}</div>` : ''}<div class="lw-box-body">${inner}</div></div>`;
    }
    if (name === 'cols') {
      const ratio = /^\d+(\s*:\s*\d+)+$/.test(args) ? args.split(':').map((s) => `minmax(0,${s.trim()}fr)`).join(' ') : '';
      return `<div class="lw-cols"${ratio ? ` style="grid-template-columns:${ratio}"` : ''}>${inner}</div>`;
    }
    if (name === 'col') return `<div class="lw-col">${inner}</div>`;
    const classes = [name, ...args.split(/\s+/)].filter((x) => /^[\w-]+$/.test(x)).map((x) => 'lw-' + x);
    return `<div class="${classes.join(' ')}">${inner}</div>`;
  }

  function directive(name, argStr) {
    const a = parseArgs(argStr);
    const attr = (v) => escapeHtml(String(v));
    const caption = a.caption ? `<figcaption>${inline(a.caption)}</figcaption>` : '';
    switch (name) {
      case 'page':
        return '';
      case 'widget': {
        const [wname] = a._;
        if (!wname) return errorBox('@widget には名前が必要です');
        const opts = { ...a };
        delete opts._;
        return `<div class="lw-widget" data-widget="${attr(wname)}" data-opts="${attr(JSON.stringify(opts))}"></div>`;
      }
      case 'exercise': {
        // 演習のカード（大きさ固定。中身は core/exercise/card.js が入れる）。問題は exercises/<id>.json
        const [ex] = a._;
        if (!ex || !/^[A-Za-z0-9_-]+$/.test(ex)) return errorBox('@exercise には演習の ID（英数字と - _）が必要です');
        const hgt = Math.max(64, Number(a.height) || 88);
        const paste = a.paste != null ? ` data-paste="${attr(a.paste)}"` : '';
        return `<div class="lw-exercise" data-exercise="${attr(ex)}"${paste} data-ink="off" style="height:${hgt}px"></div>`;
      }
      case 'space': {
        const hgt = Number(a._[0]) || Number(a.height) || 200;
        const bg = a._.find((x) => ['grid', 'lines', 'dots', 'box'].includes(x)) || a.bg;
        return `<div class="lw-space${bg ? ' lw-space-' + attr(bg) : ''}" style="height:${hgt}px"></div>`;
      }
      case 'image': {
        const src = a._[0] || a.src;
        if (!src) return errorBox('@image には画像のパスが必要です');
        const size = (a.width ? ` width="${attr(a.width)}"` : '') + (a.height ? ` height="${attr(a.height)}"` : '');
        return `<figure class="lw-figure"><img src="${attr(src)}"${size} alt="${attr(a.alt || '')}">${caption}</figure>`;
      }
      case 'video': {
        const src = a._[0] || a.src;
        if (!src) return errorBox('@video には動画のパスが必要です');
        const w = Number(a.width) || 640;
        const hgt = Number(a.height) || Math.round(w * 9 / 16);
        const flags = (a.loop || a._.includes('loop') ? ' loop' : '') +
          (a.muted || a.autoplay || a._.includes('muted') || a._.includes('autoplay') ? ' muted' : '') +
          (a.autoplay || a._.includes('autoplay') ? ' autoplay' : '');
        const poster = a.poster ? ` poster="${attr(a.poster)}"` : '';
        return `<figure class="lw-figure lw-video"><video src="${attr(src)}" width="${w}" height="${hgt}" style="width:${w}px;height:${hgt}px" controls playsinline webkit-playsinline preload="metadata"${poster}${flags}></video>${caption}</figure>`;
      }
      case 'iframe': {
        const src = a._[0] || a.src;
        if (!src) return errorBox('@iframe には URL が必要です');
        const w = a.width || '100%';
        const hgt = Number(a.height) || 400;
        return `<figure class="lw-figure lw-iframe"><iframe src="${attr(src)}" style="width:${/^\d+$/.test(String(w)) ? w + 'px' : attr(w)};height:${hgt}px" loading="eager"></iframe>${caption}</figure>`;
      }
      default:
        return errorBox(`不明なディレクティブ @${escapeHtml(name)}`);
    }
  }

  return { tex, md, inline, page };
}

function errorBox(msg) {
  return `<div class="lw-error">${msg}</div>`;
}

function findFenceEnd(lines, i, fence) {
  const ch = fence[0];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t.length >= fence.length && t.split('').every((c) => c === ch)) return j;
  }
  return lines.length - 1;
}

function findContainerEnd(lines, i) {
  let depth = 1;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { j = findFenceEnd(lines, j, f[1]); continue; }
    if (/^\s*:::+\s*[A-Za-z]/.test(line)) depth++;
    else if (/^\s*:::+\s*$/.test(line) && --depth === 0) return j;
  }
  return lines.length;
}

// ---------------------------------------------------------------
// 数式の退避：コード（``` / `）を避けつつ $$..$$, \[..\], $..$, \(..\) を置換
// ---------------------------------------------------------------
function protectMath(src, store) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lineStart = true;
  while (i < n) {
    const c = src[i];
    if (lineStart) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(src.slice(i, i + 32));
      if (f) {
        const ch = f[1][0] === '`' ? '`' : '~';
        const re = new RegExp(`\\n {0,3}${ch === '`' ? '`' : '~'}{${f[1].length},}[ \\t]*(?=\\n|$)`, 'g');
        re.lastIndex = i + f[0].length;
        const m = re.exec(src);
        const end = m ? m.index + m[0].length : n;
        out += src.slice(i, end);
        i = end;
        lineStart = false;
        continue;
      }
    }
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '[' || d === '(') {
        const j = src.indexOf(d === '[' ? '\\]' : '\\)', i + 2);
        if (j >= 0) {
          out += store(src.slice(i + 2, j), d === '[');
          i = j + 2;
          lineStart = false;
          continue;
        }
      }
      out += src.slice(i, i + 2);
      lineStart = d === '\n';
      i += 2;
      continue;
    }
    if (c === '`') {
      let k = 1;
      while (src[i + k] === '`') k++;
      const ticks = '`'.repeat(k);
      let j = i + k;
      let found = -1;
      while ((j = src.indexOf(ticks, j)) >= 0) {
        let e = j + k;
        if (src[e] !== '`') { found = j; break; }
        while (src[e] === '`') e++;
        j = e;
      }
      if (found >= 0) {
        out += src.slice(i, found + k);
        i = found + k;
      } else {
        out += ticks;
        i += k;
      }
      lineStart = false;
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === '$') {
        const j = src.indexOf('$$', i + 2);
        if (j >= 0) {
          out += store(src.slice(i + 2, j), true);
          i = j + 2;
          lineStart = false;
          continue;
        }
      } else {
        const j = findInlineClose(src, i + 1);
        if (j > 0) {
          out += store(src.slice(i + 1, j), false);
          i = j + 1;
          lineStart = false;
          continue;
        }
      }
    }
    out += c;
    lineStart = c === '\n';
    i++;
  }
  return out;
}

function findInlineClose(src, start) {
  const first = src[start];
  if (!first || /\s/.test(first) || first === '$') return -1;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '`') return -1; // コードスパンをまたがない
    if (ch === '\n' && src[j + 1] === '\n') return -1;
    if (ch === '$') {
      if (/\s/.test(src[j - 1]) || /\d/.test(src[j + 1] || '')) continue;
      return j;
    }
  }
  return -1;
}
