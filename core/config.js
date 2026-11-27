// =============================================================
// 共通定数
// ここの値の多くは「保存済みの書き込みデータの座標系」に影響する。
// 特に PAGE_WIDTH と pressureFactor の式（ink/stroke.js）は、
// 変更すると既存の書き込みと教材の位置関係が崩れるので変更しないこと。
// =============================================================

/** 論理ページ幅（px）。教材レイアウトと手書き座標の共通単位。 */
export const PAGE_WIDTH = 1024;

/**
 * 画面に最低限収めたいページの縦横比（高さ / 幅）。
 * 横長ディスプレイ（PC）では幅ではなく高さ基準で縮小し、
 * 1024 x 635 程度の領域が必ず一画面に入るようにする。
 */
export const MIN_VISIBLE_RATIO = 0.62;

/** 手書きキャンバスの最大解像度倍率（論理px → 実ピクセル） */
export const MAX_INK_RESOLUTION = 3;

/**
 * ピンチで拡大できる最大の倍率（1 = 画面に合わせた大きさ）。
 * 手書きのタイルはページの全幅なので解像度は MAX_INK_RESOLUTION で頭打ちになる。
 * 大きくしすぎると拡大時の書き込みがぼやける（iPad 横向きで 3 倍のとき、実際の画素の約 4 割）。
 */
export const MAX_ZOOM = 3;

/** 手書きキャンバスのタイル高さ（論理px）と重なり幅 */
export const TILE_HEIGHT = 512;
export const TILE_OVERLAP = 2;
/** 画面外に何画面分まで先読みでタイルを確保するか */
export const TILE_MARGIN_SCREENS = 0.5;

/** 筆圧なし入力（マウス・指・筆圧OFF）で記録する標準筆圧 */
export const NEUTRAL_PRESSURE = 0.25;
/** 筆圧の平滑化係数（0..1, 大きいほど追従が速い） */
export const PRESSURE_SMOOTHING = 0.35;
/** これより近い点は間引く（論理px） */
export const MIN_POINT_DISTANCE = 0.35;

/** ペンを離してからこの時間（ms）は指タッチを無視する（パームリジェクション） */
export const PALM_GUARD_MS = 450;
/** ツールバーは短く（書いてすぐ指でボタンを押したときに反応しないと、固まったように見えるため） */
export const TOOLBAR_PALM_GUARD_MS = 250;
/** この半径（px）より大きいタッチは手のひらとみなす（取得できる環境のみ）。
 *  ペンを最後に使ってから PALM_RECENT_MS の間だけ適用する（長すぎると指のスクロールが効かず固まったように見える） */
export const PALM_RADIUS = 45;
export const PALM_RECENT_MS = 1500;

/** ペン先のダブルタップ（ペン⇔消しゴムの切り替え）：1 回のタップの長さ・ずれ、2 回の間隔・距離（論理px） */
export const DOUBLE_TAP = { tapMs: 250, tapMove: 4, gapMs: 350, dist: 9 };

/** 指スワイプによるページ送りの判定 */
export const SWIPE = { minDx: 90, maxSlope: 0.45, maxMs: 650 };

/** ツール既定値 */
export const PEN_COLORS = ['#1b1b1f', '#1f5fd6', '#d62828', '#138a36', '#e07b00'];
export const HL_COLORS = ['#fff176', '#b9f6ca', '#ffc1e3', '#b3e5fc'];
export const PEN_WIDTHS = [1.6, 2.6, 4.2];
export const HL_WIDTHS = [12, 20, 30];
export const ERASER_SIZES = [8, 18, 36];

/** レーザーポインタ（保存されない一時的な指し示し） */
export const LASER_COLORS = ['#ff2a2a', '#20c05a', '#2f7bff', '#ff9a1a'];
/** 軌跡モード：ペンを離してから消え始めるまで（ms）。続けて書けば全体が残る */
export const LASER_HOLD_MS = 600;
/** 軌跡モード：消えるまでのフェード時間（ms） */
export const LASER_FADE_MS = 600;
/** 点モード：ペンを離してから消えるまで（ms） */
export const LASER_DOT_FADE_MS = 250;

/** テキスト：色はペンと同じ。文字サイズ（論理px。教材の本文は 24） */
export const TEXT_SIZES = [18, 24, 32];

/** ページ背景 */
export const BACKGROUNDS = ['none', 'grid', 'lines', 'dots'];

/** 板書スペース拡張1回あたりの量（画面高さに対する比） */
export const EXTEND_RATIO = 0.5;

/** 保存 */
export const DB_NAME = 'lecture-web';
export const DB_VERSION = 2;   // 2: 教材ライブラリ（library, kv）を追加
export const INK_FORMAT = 'lecture-web-ink';
export const INK_FORMAT_VERSION = 1;
export const SAVE_DELAY_MS = 800;
export const HISTORY_LIMIT = 300;
