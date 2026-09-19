/* ============================================================
   core.js —— 基础设施：DOM 工具、状态、提示、图像处理辅助
   ============================================================ */

/** 全局单一状态树，所有模块共享读写 */
export const state = {
  theme: localStorage.getItem('qs.theme') || 'dark',
  tab: 'remove',              // remove | add | batch
  tool: 'brush',              // brush | rect | eraser | mosaic
  brushSize: 40,
  showMask: true,

  sourceImage: null,          // 当前底图 ImageData 的载体 canvas（原始尺寸）
  fileName: 'image',
  resultCanvas: null,         // 最近的修复结果（原始尺寸）
  comparing: true,
  compareRatio: 0.5,

  zoom: null,                 // null = 自适应
  engine: 'ai',

  wmType: 'text',
  wmSettings: {
    text: '© Eraser',
    size: 28, opacity: 45, color: '#ffffff', angle: 0,
    font: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    logoScale: 30, logoOpacity: 50, logoAngle: 0,
    logoCanvas: null, logoName: '',
    position: 'bottom-right', padX: 24, padY: 24,
    tileX: 160, tileY: 120, shadow: false,
  },
  wmPreview: true,

  batch: [],                  // { id, name, canvas, file, status, result }
  batchEngine: 'ai',
  batchCurrentId: null,       // 正在作为批次参考图的文件 id
};

/* ---------------- DOM ---------------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(el, evt, fn, opts) {
  el.addEventListener(evt, fn, opts);
  return () => el.removeEventListener(evt, fn, opts);
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- Toast ---------------- */
export function toast(msg, type = '', ms = 2400) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : '';
  el.innerHTML = `${icon ? `<b>${icon}</b>` : ''}<span></span>`;
  el.querySelector('span').textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
  // 最多同时保留 4 条
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
}

/* ---------------- 主题 ---------------- */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  state.theme = theme;
  localStorage.setItem('qs.theme', theme);
}
export const toggleTheme = () =>
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');

/* ---------------- Canvas 辅助 ---------------- */

/** 创建指定尺寸的离屏 canvas */
export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * 从任意图片源绘制出一张指定尺寸的 canvas
 * 注意：此处刻意不加 willReadFrequently —— 该标志会让浏览器改用 CPU 软件渲染后端，
 * 使 drawImage 失去 GPU 加速。本函数只做绘制，不读像素，因此必须保留 GPU 路径。
 */
export function canvasFromSource(src, w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/** 需要频繁 getImageData 的场景用这个变体（走 CPU 后端，读取快） */
export function createReadableCanvas(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return { canvas: c, ctx };
}

/** 读取 File 为 HTMLImageElement */
export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('不是图片文件'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

/** 读取 File 为 canvas（原始尺寸） */
export async function canvasFromFile(file) {
  const img = await loadImageFromFile(file);
  return canvasFromSource(img, img.naturalWidth, img.naturalHeight);
}

/** canvas -> Blob */
export function canvasToBlob(canvas, type = 'image/png', quality = 0.95) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

/** canvas -> dataURL */
export const canvasToDataURL = (canvas, type = 'image/png', q = 0.95) =>
  canvas.toDataURL(type, q);

/** dataURL -> canvas */
export function dataURLToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(canvasFromSource(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/** 触发浏览器下载 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** 导出 canvas 并下载 */
export async function downloadCanvas(canvas, filename, ext = 'png') {
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await canvasToBlob(canvas, mime, 0.95);
  downloadBlob(blob, filename);
}

/** 文件大小友好显示 */
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 ** 2).toFixed(1) + ' MB';
}

/** 睡眠，让出主线程以刷新 UI */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------
   尺寸上限：这是载入速度的关键开关
   每张图会同时创建 3 张等尺寸 canvas（底图 / 遮罩 / 绘制层），
   且撤销历史还会缓存多份遮罩副本，因此像素总量必须受控。
   处理更大的图请调高 MAX_EDGE（如 4096），代价是内存与耗时上升。
   ------------------------------------------------------------ */
export const MAX_PIXELS = 8e6;   // 总像素上限：约 800 万
export const MAX_EDGE = 2560;    // 最长边上限：主流高清标准

export function fitWithin(w, h, maxPx = MAX_PIXELS, maxEdge = MAX_EDGE) {
  let ow = w, oh = h;

  // 先约束最长边
  const edge = Math.max(ow, oh);
  if (edge > maxEdge) {
    const s = maxEdge / edge;
    ow = Math.round(ow * s);
    oh = Math.round(oh * s);
  }
  // 再约束总像素（应对极端宽高比）
  const px = ow * oh;
  if (px > maxPx) {
    const s = Math.sqrt(maxPx / px);
    ow = Math.round(ow * s);
    oh = Math.round(oh * s);
  }
  return { w: Math.max(1, ow), h: Math.max(1, oh) };
}
