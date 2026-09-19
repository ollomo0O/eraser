/* ============================================================
   mask.js —— 画布画板：底图渲染、遮罩标记、马赛克笔、撤销重做
   三图层结构：
     baseCanvas 底图（原始像素）
     maskCanvas 遮罩（半透明红色，alpha 即选中区域）
     drawCanvas 事件层 + 矩形预览 + 马赛克即时笔迹
   ============================================================ */

import { $, createCanvas, canvasFromSource, clamp, sleep } from './core.js';

const MASK_FILL = 'rgba(248, 81, 73, 0.55)';
// 每条历史都会缓存整张遮罩副本，大图下内存开销可观，故限制步数
const HISTORY_LIMIT = 8;

export class MaskBoard {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.wrap      三层 canvas 的容器
   * @param {HTMLCanvasElement} opts.base
   * @param {HTMLCanvasElement} opts.mask
   * @param {HTMLCanvasElement} opts.draw
   * @param {Function} [opts.onChange]   遮罩变化时回调
   */
  constructor({ wrap, base, mask, draw, onChange }) {
    this.wrap = wrap;
    this.baseCanvas = base;
    this.maskCanvas = mask;
    this.drawCanvas = draw;
    this.onChange = onChange || (() => {});

    // base 主要用于 drawImage 显示/合成，必须保留 GPU 加速，不能加 willReadFrequently
    this.baseCtx = base.getContext('2d');
    // mask 需要频繁 getImageData（hasMask / getMaskBounds），走 CPU 后端读取更快
    this.maskCtx = mask.getContext('2d', { willReadFrequently: true });
    this.drawCtx = draw.getContext('2d');

    this.width = 0;
    this.height = 0;
    this.zoom = 1;
    this.tool = 'brush';
    this.brushSize = 40;
    this.showMask = true;
    this.enabled = true;          // 处理中禁用交互
    this.mosaicBlock = 12;        // 马赛克块边长（相对原始像素）

    this.history = [];
    this.future = [];
    this._drawing = false;
    this._rectStart = null;
    this._mosaicCache = null;     // 整图马赛克化缓存
    this._maskEmpty = true;       // 遮罩空标记，避免频繁全图扫描
    this._mosaicUsed = false;     // 底图是否被马赛克笔改动过（决定是否缓存底图快照）

    this._bind();
  }

  /* ---------------- 图片装载 ---------------- */

  /** 装载一张底图（canvas 或 Image），重置遮罩与历史 */
  setImage(source, w, h) {
    this.width = w;
    this.height = h;
    [this.baseCanvas, this.maskCanvas, this.drawCanvas].forEach((c) => {
      c.width = w; c.height = h;
    });
    this.baseCtx.clearRect(0, 0, w, h);
    this.baseCtx.drawImage(source, 0, 0, w, h);
    this.clearMask(false);
    this.history = [];
    this.future = [];
    this._mosaicCache = null;
    this._mosaicUsed = false;
  }

  /** 用一张 canvas 覆盖底图（不重置遮罩，用于“作为新底图”） */
  replaceBase(canvas) {
    this.baseCtx.clearRect(0, 0, this.width, this.height);
    this.baseCtx.drawImage(canvas, 0, 0, this.width, this.height);
    this._mosaicCache = null;
  }

  get baseAsCanvas() {
    return canvasFromSource(this.baseCanvas, this.width, this.height);
  }

  /* ---------------- 缩放 ---------------- */

  setZoom(z) {
    this.zoom = z;
    const w = Math.round(this.width * z);
    const h = Math.round(this.height * z);
    this.wrap.style.width = w + 'px';
    this.wrap.style.height = h + 'px';
    // 三层 canvas 必须统一显示尺寸：遮罩层/绘制层用 CSS 100% 铺满 wrap，
    // 而底图若不带 CSS 尺寸就会按内部像素原始大小渲染，缩放后两者会错位。
    [this.baseCanvas, this.maskCanvas, this.drawCanvas].forEach((c) => {
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    });
  }

  fitInto(container, padding = 56) {
    if (!this.width) return 1;
    const availW = container.clientWidth - padding;
    const availH = container.clientHeight - padding;
    const z = Math.min(availW / this.width, availH / this.height, 1);
    const zoom = Math.max(z, 0.02);
    this.setZoom(zoom);
    return zoom;
  }

  /* ---------------- 遮罩 ---------------- */

  clearMask(record = true) {
    if (record) this._snapshot();
    this.maskCtx.clearRect(0, 0, this.width, this.height);
    this.drawCtx.clearRect(0, 0, this.width, this.height);
    this._maskEmpty = true;
    this._notify();
    if (record) this.onChange();
  }

  /**
   * 遮罩是否非空 —— O(1) 标志位
   * 这个方法会在每次 pointermove 时被调用，绝不能做全图 getImageData，
   * 否则大图下每移动一下鼠标就要拷贝几十 MB 像素，直接卡死。
   */
  /** 把一批矩形一次性写入遮罩（用于「识别全部」结果的批量应用） */
  fillMaskRects(rects) {
    if (!rects?.length) return;
    this.maskCtx.fillStyle = MASK_FILL;
    for (const r of rects) this.maskCtx.fillRect(r.x, r.y, r.w, r.h);
    this._maskEmpty = false;
    this._notify();
    this.onChange();
  }

  hasMask() {
    return !!(this.width && !this._maskEmpty);
  }

  /** 精确判断是否真有遮罩（全图扫描，仅在真正执行处理前调用一次） */
  hasMaskExact() {
    if (!this.width) return false;
    const d = this.maskCtx.getImageData(0, 0, this.width, this.height).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 0) return true;
    return false;
  }

  /** 遮罩的外接矩形（原始像素坐标），null 表示无遮罩 */
  getMaskBounds() {
    if (!this.width) return null;
    const { data } = this.maskCtx.getImageData(0, 0, this.width, this.height);
    let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.height; y++) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (data[(row + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** 返回二值遮罩 canvas：黑底白字（白=需修复） */
  getMaskBinaryCanvas() {
    const c = createCanvas(this.width, this.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    const img = this.maskCtx.getImageData(0, 0, this.width, this.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const on = d[i + 3] > 0;
      d[i] = d[i + 1] = d[i + 2] = on ? 255 : 0;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** 从二值 canvas 载入遮罩显示 */
  loadMaskBinaryCanvas(binCanvas) {
    this._snapshot();
    const w = Math.min(binCanvas.width, this.width);
    const h = Math.min(binCanvas.height, this.height);
    const src = binCanvas.getContext('2d').getImageData(0, 0, w, h);
    const out = this.maskCtx.createImageData(w, h);
    const s = src.data, d = out.data;
    for (let i = 0; i < s.length; i += 4) {
      const on = s[i] > 127;
      // 写回半透明红色（保持显示一致）
      d[i] = 248; d[i + 1] = 81; d[i + 2] = 73;
      d[i + 3] = on ? 140 : 0;
    }
    this.maskCtx.putImageData(out, 0, 0);
    this._maskEmpty = false;
    this._notify();
    this.onChange();
  }

  /** 遮罩覆盖的像素面积占比 */
  maskRatio() {
    const b = this.getMaskBounds();
    if (!b) return 0;
    return (b.w * b.h) / (this.width * this.height);
  }

  setShowMask(v) {
    this.showMask = v;
    this._notify();
  }

  _notify() {
    this.maskCanvas.style.opacity = this.showMask ? '1' : '0';
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  /**
   * 记录一步历史。
   * 底图只有在使用马赛克笔时才被改动，其余工具（画笔/矩形/橡皮）只改遮罩，
   * 因此只在 _mosaicUsed 为真时才复制底图 —— 大图下每复制一次就要几十 MB。
   */
  _snapshot() {
    if (!this.width) return;
    const snap = {
      base: this._mosaicUsed ? canvasFromSource(this.baseCanvas, this.width, this.height) : null,
      mask: canvasFromSource(this.maskCanvas, this.width, this.height),
    };
    this.history.push(snap);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
  }

  _curSnapshot() {
    return {
      base: this._mosaicUsed ? canvasFromSource(this.baseCanvas, this.width, this.height) : null,
      mask: canvasFromSource(this.maskCanvas, this.width, this.height),
    };
  }

  _restore(snap) {
    if (!snap) return;
    if (snap.base) {
      this.baseCtx.clearRect(0, 0, this.width, this.height);
      this.baseCtx.drawImage(snap.base, 0, 0);
    }
    this.maskCtx.clearRect(0, 0, this.width, this.height);
    this.maskCtx.drawImage(snap.mask, 0, 0);
    this._mosaicCache = null;
    this._notify();
    this.onChange();
  }

  /** 快照当前状态压入 future，回退到 history 末尾 */
  undo() {
    if (!this.history.length) return false;
    this.future.push(this._curSnapshot());
    this._restore(this.history.pop());
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.history.push(this._curSnapshot());
    this._restore(this.future.pop());
    return true;
  }

  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }

  /* ---------------- 绘制交互 ---------------- */

  _bind() {
    const c = this.drawCanvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('pointerleave', (e) => { if (this._drawing) this._up(e); });
  }

  /** 客户端坐标 -> 画布原始像素坐标 */
  _pos(e) {
    const r = this.drawCanvas.getBoundingClientRect();
    const sx = this.width / r.width;
    const sy = this.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  _down(e) {
    if (!this.enabled || !this.width) return;
    e.preventDefault();
    this.drawCanvas.setPointerCapture?.(e.pointerId);
    const p = this._pos(e);

    if (this.tool === 'rect') {
      this._rectStart = p;
      this._drawing = true;
      return;
    }
    this._snapshot();
    this._drawing = true;
    this._last = null;
    this._stroke(p);
  }

  _move(e) {
    if (!this.enabled || !this.width) return;
    const p = this._pos(e);
    if (this.tool === 'rect' && this._drawing && this._rectStart) {
      this._drawRectPreview(this._rectStart, p);
      return;
    }
    if (!this._drawing) return;
    e.preventDefault();
    this._stroke(p);
  }

  _up(e) {
    if (!this._drawing) return;
    this._drawing = false;
    if (this.tool === 'rect' && this._rectStart) {
      const p = this._pos(e);
      this.drawCtx.clearRect(0, 0, this.width, this.height);
      const x = Math.min(this._rectStart.x, p.x);
      const y = Math.min(this._rectStart.y, p.y);
      const w = Math.abs(p.x - this._rectStart.x);
      const h = Math.abs(p.y - this._rectStart.y);
      if (w > 2 && h > 2) {
        this._snapshot();
        this.maskCtx.fillStyle = MASK_FILL;
        this.maskCtx.fillRect(x, y, w, h);
        this._maskEmpty = false;
        this._notify();
        this.onChange();
      }
      this._rectStart = null;
      this.future = [];
    }
    this._last = null;
  }

  _stroke(p) {
    if (this.tool === 'eraser') {
      this._erase(p);
    } else if (this.tool === 'mosaic') {
      this._paintMosaic(p);   // 马赛克改的是底图，不影响遮罩标记
    } else {
      this._paintMask(p);
      this._maskEmpty = false;
    }
    this.onChange();
  }

  /** 画笔：叠加遮罩 */
  _paintMask(p) {
    const ctx = this.maskCtx;
    ctx.fillStyle = MASK_FILL;
    ctx.strokeStyle = MASK_FILL;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.brushSize;
    if (this._last) {
      ctx.beginPath();
      ctx.moveTo(this._last.x, this._last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    this._last = p;
    this._notify();
  }

  /** 橡皮：擦除遮罩 */
  _erase(p) {
    const ctx = this.maskCtx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.brushSize;
    if (this._last) {
      ctx.beginPath();
      ctx.moveTo(this._last.x, this._last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this._last = p;
    this._notify();
  }

  /** 马赛克：把预生成的整图马赛克按圆形蒙版合成到底图 */
  _paintMosaic(p) {
    if (!this._mosaicCache) this._mosaicCache = buildMosaic(this.baseCanvas, this.width, this.height, this.mosaicBlock);
    const ctx = this.baseCtx;
    const r = this.brushSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (this._last) {
      // 沿轨迹补出胶囊形，避免快速移动出现断点
      const a = this._last, b = p;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const nx = Math.cos(ang + Math.PI / 2) * r;
      const ny = Math.sin(ang + Math.PI / 2) * r;
      ctx.moveTo(a.x + nx, a.y + ny);
      ctx.lineTo(b.x + nx, b.y + ny);
      ctx.lineTo(b.x - nx, b.y - ny);
      ctx.lineTo(a.x - nx, a.y - ny);
      ctx.closePath();
    }
    ctx.clip();
    ctx.drawImage(this._mosaicCache, 0, 0);
    ctx.restore();
    this._mosaicUsed = true;
    this._last = p;
  }

  _drawRectPreview(a, b) {
    const ctx = this.drawCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.strokeStyle = '#f85149';
    ctx.setLineDash([8 / this.zoom, 6 / this.zoom]);
    ctx.lineWidth = 1.5 / this.zoom;
    ctx.strokeRect(
      Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.abs(b.x - a.x), Math.abs(b.y - a.y)
    );
    ctx.restore();
  }
}

/* ---------------- 马赛克算法 ---------------- */

/** 对整张图做区块均值马赛克，返回新 canvas */
export function buildMosaic(srcCanvas, w, h, block = 12) {
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');   // 产物会被 drawImage 合成到底图，保持 GPU 路径
  const b = Math.max(2, Math.round(block));
  const img = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const d = img.data;

  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      const bw = Math.min(b, w - bx);
      const bh = Math.min(b, h - by);
      let r = 0, g = 0, bl = 0, a = 0, n = 0;
      // 采样块内像素求均值（步长 2 提速）
      for (let y = by; y < by + bh; y += 2) {
        const row = y * w;
        for (let x = bx; x < bx + bw; x += 2) {
          const i = (row + x) * 4;
          r += d[i]; g += d[i + 1]; bl += d[i + 2]; a += d[i + 3]; n++;
        }
      }
      if (!n) { r = g = bl = 0; a = d[((by * w) + bx) * 4 + 3]; n = 1; }
      const rr = (r / n) | 0, gg = (g / n) | 0, bb = (bl / n) | 0, aa = (a / n) | 0;
      // 整块填色
      for (let y = by; y < by + bh; y++) {
        let i = (y * w + bx) * 4;
        for (let x = 0; x < bw; x++) {
          d[i] = rr; d[i + 1] = gg; d[i + 2] = bb; d[i + 3] = aa;
          i += 4;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** 按给定区域的 alpha 通道做马赛克（用于选中区打码） */
export function mosaicRegion(baseCanvas, maskBinary, w, h, block = 12) {
  const mos = buildMosaic(baseCanvas, w, h, block);
  const out = canvasFromSource(baseCanvas, w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  const mctx = maskBinary.getContext('2d', { willReadFrequently: true });
  const mImg = mctx.getImageData(0, 0, w, h);
  const oImg = ctx.getImageData(0, 0, w, h);
  const md = mImg.data, od = oImg.data;
  const mosData = mos.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  for (let i = 0; i < md.length; i += 4) {
    if (md[i] > 127) {
      od[i] = mosData[i]; od[i + 1] = mosData[i + 1]; od[i + 2] = mosData[i + 2];
    }
  }
  ctx.putImageData(oImg, 0, 0);
  return out;
}
