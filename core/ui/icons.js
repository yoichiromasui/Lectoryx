// ツールバー用アイコン（24x24, currentColor）
const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  pages: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  addPage: svg('<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>'),
  hand: svg('<path d="M6 3.5l12 7.2-5.3 1.4 3.1 5.6-2.4 1.3-3.1-5.6L6.5 17z"/>'),
  pen: svg('<path d="M4 20l1.2-4.4L16.6 4.2a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.4 18.8z"/><path d="M14.5 6.3l3.2 3.2"/>'),
  highlighter: svg('<path d="M9.5 14.5l-3 3 1 1.5h4l1.5-1.5"/><path d="M9.5 14.5l8.6-8.6a2 2 0 0 1 2.8 2.8L12.3 17.3z"/><path d="M3 21h8"/>'),
  eraser: svg('<path d="M9 20h11"/><path d="M4.6 15.4l9.8-9.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.2z"/><path d="M9.5 10.5l5 5"/>'),
  laser: svg('<path d="M3.5 20.5L13 11"/><circle cx="16" cy="8" r="2.6" fill="currentColor"/><path d="M16 2v1.6M16 12.4V14M22 8h-1.6M11.6 8H10M20.2 3.8l-1.1 1.1M12.9 11.1l-1.1 1.1M20.2 12.2l-1.1-1.1"/>'),
  text: svg('<path d="M5 7V4.5h14V7"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  extend: svg('<path d="M12 3v11M7.5 9.5L12 14l4.5-4.5"/><path d="M4 19.5h16"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  collapse: svg('<path d="M6 15l6-6 6 6"/>'),
  expand: svg('<path d="M6 9l6 6 6-6"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  home: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
};
