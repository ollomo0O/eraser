/* ============================================================
   batch.js —— 批量队列管理
   在一张参考图上标记一次遮罩，按等比缩放应用到队列中所有图片
   ============================================================ */

import {
  state, createCanvas, canvasFromSource, canvasFromFile,
  canvasToBlob, downloadBlob, uid, sleep, fitWithin, toast, $, fmtBytes,
} from './core.js';
import { MaskBoard } from './mask.js';
import { aiInpaint, fastInpaint } from './inpaint.js';

/** 参考图最长边：兼顾标记精度与内存 */
const REF_MAX = 700;

export class BatchManager {
  constructor({ onUpdate, modelProgress }) {
    this.onUpdate = onUpdate || (() => {});
    this.modelProgress = modelProgress || (() => {});
    this.items = [];
    this.running = false;

    const wrap = $('.batch-mask-canvas');
    this.board = new MaskBoard({
      wrap,
      base: $('#batchRefCanvas'),
      mask: $('#batchMaskCanvas'),
      draw: $('#batchDrawCanvas'),
      onChange: () => this.onUpdate(),
    });
    // 批量画板不需要马赛克工具
    this.board.mosaicBlock = 10;
  }

  get current() {
    return this.items.find((i) => i.id === state.batchCurrentId) || null;
  }

  /* ---------------- 队列增删 ---------------- */

  async addFiles(files) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) { toast('未识别到图片文件', 'error'); return; }

    for (const file of imgs) {
      try {
        const raw = await canvasFromFile(file);
        const fit = fitWithin(raw.width, raw.height);
        const canvas = fit.w === raw.width && fit.h === raw.height
          ? raw
          : canvasFromSource(raw, fit.w, fit.h);
        this.items.push({
          id: uid(),
          name: file.name,
          canvas,
          thumb: null,
          status: 'pending',   // pending | running | done | error
          result: null,
          message: '',
        });
      } catch (e) {
        toast(`${file.name} 读取失败`, 'error');
      }
    }

    if (!state.batchCurrentId && this.items.length) this.setCurrent(this.items[0].id);
    this.onUpdate();
  }

  setCurrent(id) {
    state.batchCurrentId = id;
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this._loadReference(item.canvas);
    this.onUpdate();
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    if (state.batchCurrentId === id) {
      state.batchCurrentId = this.items[0]?.id || null;
      const cur = this.current;
      if (cur) this._loadReference(cur.canvas);
      else this.board.clearMask(false);
    }
    this.onUpdate();
  }

  clearResults() {
    this.items.forEach((i) => { i.status = 'pending'; i.result = null; i.message = ''; });
    this.onUpdate();
  }

  reset() {
    this.items = [];
    state.batchCurrentId = null;
    $('#batchRefCanvas').width = $('#batchRefCanvas').height = 0;
    this.board.clearMask(false);
    this.onUpdate();
  }

  /* ---------------- 参考图与遮罩 ---------------- */

  _loadReference(srcCanvas) {
    const k = Math.min(REF_MAX / srcCanvas.width, REF_MAX / srcCanvas.height, 1);
    const w = Math.max(1, Math.round(srcCanvas.width * k));
    const h = Math.max(1, Math.round(srcCanvas.height * k));
    const ref = createCanvas(w, h);
    ref.getContext('2d').drawImage(srcCanvas, 0, 0, w, h);
    this.refSize = { w, h };
    this.board.setImage(ref, w, h);
    this.board.onChange = () => this.onUpdate();
  }

  hasMask() { return this.board.hasMask(); }

  getBoundsText() {
    if (!this.hasMask()) return '未标记';
    const b = this.board.getMaskBounds();
    const r = this.board.maskRatio();
    return `${b.w}×${b.h}，占比 ${(r * 100).toFixed(1)}%`;
  }

  /** 把参考图上的遮罩等比缩放为某张目标图的二值遮罩 */
  maskFor(target) {
    const W = target.canvas.width, H = target.canvas.height;
    const bin = createCanvas(W, H);
    const ctx = bin.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // 先渲染成白底（把半透明标记转成不透明白）
    const solid = createCanvas(this.refSize.w, this.refSize.h);
    const sctx = solid.getContext('2d', { willReadFrequently: true });
    const src = this.board.maskCtx.getImageData(0, 0, this.refSize.w, this.refSize.h);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      const on = d[i + 3] > 0;
      d[i] = d[i + 1] = d[i + 2] = on ? 255 : 0;
      d[i + 3] = on ? 255 : 0;
    }
    sctx.putImageData(src, 0, 0);

    ctx.drawImage(solid, 0, 0, this.refSize.w, this.refSize.h, 0, 0, W, H);
    return bin;
  }

  /* ---------------- 批量执行 ---------------- */

  async runAll() {
    if (this.running) return;
    if (!this.items.length) { toast('队列为空', 'error'); return; }
    if (!this.hasMask()) { toast('请先在参考图上标记水印区域', 'error'); return; }

    this.running = true;
    this.clearResults();
    const engine = state.batchEngine;
    let done = 0, failed = 0;

    try {
      for (const item of this.items) {
        item.status = 'running';
        item.message = '处理中';
        this.onUpdate();
        await sleep(30);

        try {
          const mask = this.maskFor(item);
          const result = engine === 'ai'
            ? await aiInpaint(item.canvas, mask, (msg, p) => {
                item.message = msg;
                this.modelProgress(msg, p);
                this.onUpdate();
              })
            : fastInpaint(item.canvas, mask, (msg, p) => {
                item.message = msg;
                this.modelProgress(msg, p);
                this.onUpdate();
              });
          item.result = result;
          item.status = 'done';
          item.message = '完成';
          done++;
        } catch (e) {
          console.error(e);
          item.status = 'error';
          item.message = e.message || '失败';
          failed++;
        }

        this.onUpdate();
        await sleep(10);
      }

      toast(
        failed
          ? `批量完成：成功 ${done} 张，失败 ${failed} 张`
          : `批量完成：已处理 ${done} 张图片`,
        failed ? 'error' : 'success'
      );
    } finally {
      this.running = false;
      this.onUpdate();
    }
    return { done, failed };
  }

  /* ---------------- 导出 ---------------- */

  async downloadZip() {
    const ready = this.items.filter((i) => i.status === 'done' && i.result);
    if (!ready.length) { toast('没有已完成的结果', 'error'); return; }

    if (typeof JSZip === 'undefined') {
      // 兜底：逐个下载
      for (const item of ready) {
        const blob = await canvasToBlob(item.result);
        downloadBlob(blob, cleanedName(item.name));
        await sleep(180);
      }
      return;
    }

    const zip = new JSZip();
    const folder = zip.folder('无水印图片');
    for (const item of ready) {
      const blob = await canvasToBlob(item.result);
      folder.file(cleanedName(item.name), blob);
    }
    const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
      this.modelProgress(`打包中 ${meta.percent.toFixed(0)}%`, meta.percent / 100);
    });
    downloadBlob(blob, `批量去水印_${ready.length}张.zip`);
    this.modelProgress('', 0);
  }

  get summaryText() {
    const total = this.items.length;
    const done = this.items.filter((i) => i.status === 'done').length;
    return done ? `${done} / ${total} 已完成` : `${total} 张待处理`;
  }
}

function cleanedName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}_无水印.png`;
}
