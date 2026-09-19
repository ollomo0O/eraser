/* ============================================================
   inpaint.js —— 双引擎修复
     1) AI 引擎：LaMa ONNX (big-lama)，ONNX Runtime Web 浏览器内推理
     2) 快速引擎：纯 JS 多尺度邻域扩散填充，零依赖零下载
   ============================================================ */

import { createCanvas, canvasFromSource, clamp, sleep } from './core.js';

/* ---------------- 模型配置 ---------------- */
const MODEL_SIZE = 512;
const MODEL_CACHE_NAME = 'qs-lama-model-v1';

const MODEL_SOURCES = [
  'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
  // 备用源：HuggingFace 镜像加速
  'https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
];

let ortSession = null;
let modelLoading = null; // 并发去重

/* ---------------- 运行时准备 ---------------- */

function ensureOrt() {
  if (typeof ort === 'undefined') {
    throw new Error('ONNX Runtime Web 未加载，请检查网络后刷新页面');
  }
  // 关键：禁用多线程。GitHub Pages 等静态托管无法发送 COOP/COEP 头，
  // 多线程 WASM 会因缺少 crossOriginIsolated 而失败。
  try {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  } catch { /* 老版本 ORT 无此字段，忽略 */ }
  return ort;
}

export const isModelReady = () => !!ortSession;

/* ---------------- 模型下载（带进度 + 缓存） ---------------- */

async function readCachedModel() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const hit = await cache.match(MODEL_SOURCES[0]);
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch { return null; }
}

async function writeModelCache(bytes) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.put(MODEL_SOURCES[0], new Response(bytes.slice().buffer, {
      headers: { 'content-type': 'application/octet-stream' },
    }));
  } catch { /* 缓存写入失败不影响使用 */ }
}

/** 流式下载二进制，回调进度 0~1 */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败：HTTP ${res.status}`);

  const total = +(res.headers.get('content-length') || 0);
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress?.(1, buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded / total, loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * 确保 AI 模型就绪；返回推理会话。
 * @param {(p:number, loaded:number, total:number, stage:string)=>void} onProgress
 */
export async function ensureModel(onProgress) {
  if (ortSession) return ortSession;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    const runtime = ensureOrt();
    onProgress?.(0, 0, 0, 'checking');

    let bytes = await readCachedModel();
    if (bytes) {
      onProgress?.(1, bytes.length, bytes.length, 'cached');
    } else {
      let lastErr;
      for (const url of MODEL_SOURCES) {
        try {
          bytes = await fetchWithProgress(url, (p, l, t) => onProgress?.(p, l, t, 'download'));
          break;
        } catch (e) { lastErr = e; }
      }
      if (!bytes) throw lastErr || new Error('所有模型源均下载失败');
      await writeModelCache(bytes);
    }

    onProgress?.(1, bytes.length, bytes.length, 'init');
    ortSession = await runtime.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return ortSession;
  })();

  try {
    return await modelLoading;
  } finally {
    modelLoading = null;
  }
}

export async function clearModel() {
  ortSession = null;
  if ('caches' in window) {
    try { await caches.delete(MODEL_CACHE_NAME); } catch { /* noop */ }
  }
}

/* ---------------- 图像 <-> 张量 ---------------- */

/** ImageData -> CHW Float32Array，值域 [0,1] */
function imageToCHW(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = data[i] / 255;
    out[p + plane] = data[i + 1] / 255;
    out[p + plane * 2] = data[i + 2] / 255;
  }
  return out;
}

/** CHW Float32Array -> ImageData（智能识别值域 0~1 或 0~255） */
function chwToImageData(arr, dims, w, h) {
  const c = dims.length === 4 ? dims[1] : dims[0];
  const plane = w * h;
  const img = new ImageData(w, h);
  const d = img.data;

  // 侦查值域：若最大值 <= 2 视为 [0,1] 需还原到 0~255
  let maxV = 0;
  const step = Math.max(1, Math.floor(arr.length / 40000));
  for (let i = 0; i < arr.length; i += step) if (arr[i] > maxV) maxV = arr[i];
  const scale = maxV <= 2 ? 255 : 1;

  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    d[i] = clamp(arr[p] * scale, 0, 255);
    d[i + 1] = clamp(arr[p + plane] * scale, 0, 255);
    d[i + 2] = clamp(arr[p + plane * 2] * scale, 0, 255);
    d[i + 3] = 255;
  }
  void c;
  return img;
}

/* ---------------- AI 修复 ---------------- */

/**
 * 计算用于推理的裁切区域：以遮罩为中心的正方形
 * 限制边长避免大图过度缩放导致画质损失
 */
function computeCrop(bounds, imgW, imgH) {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const diag = Math.max(bounds.w, bounds.h);
  const desired = clamp(Math.ceil(diag * 2.2), 160, 1100);

  let side = Math.min(desired, imgW, imgH);
  side = Math.max(side, Math.min(imgW, imgH, 160));

  let x = Math.round(cx - side / 2);
  let y = Math.round(cy - side / 2);
  x = clamp(x, 0, Math.max(0, imgW - side));
  y = clamp(y, 0, Math.max(0, imgH - side));
  side = Math.min(side, imgW - x, imgH - y);

  return { x, y, w: side, h: side };
}

/**
 * AI 修复入口
 * @param {HTMLCanvasElement} baseCanvas  原始尺寸底图
 * @param {HTMLCanvasElement} maskBinary  二值遮罩（白=待修复）
 * @param {(msg:string, p:number)=>void} onProgress
 */
export async function aiInpaint(baseCanvas, maskBinary, onProgress) {
  await sleep(0);
  const session = await ensureModel((p, l, t, stage) => {
    if (stage === 'download') onProgress?.(`下载 AI 模型`, p * 0.85);
    else if (stage === 'init') onProgress?.('初始化推理引擎', 0.9);
    else if (stage === 'cached') onProgress?.('加载已缓存模型', 0.9);
  });

  const W = baseCanvas.width, H = baseCanvas.height;
  const bounds = bboxOfMask(maskBinary, W, H);
  if (!bounds) return canvasFromSource(baseCanvas, W, H);

  const crop = computeCrop(bounds, W, H);

  // --- 准备 512 输入 ---
  const imgCrop = createCanvas(MODEL_SIZE, MODEL_SIZE);
  const ictx = imgCrop.getContext('2d', { willReadFrequently: true });
  ictx.imageSmoothingEnabled = true;
  ictx.imageSmoothingQuality = 'high';
  ictx.drawImage(baseCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, MODEL_SIZE, MODEL_SIZE);

  const mCrop = createCanvas(MODEL_SIZE, MODEL_SIZE);
  const mctx = mCrop.getContext('2d', { willReadFrequently: true });
  mctx.drawImage(maskBinary, crop.x, crop.y, crop.w, crop.h, 0, 0, MODEL_SIZE, MODEL_SIZE);

  const imageArr = imageToCHW(ictx, MODEL_SIZE, MODEL_SIZE);

  // mask：单通道，>0 置 1
  const mData = mctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const maskArr = new Float32Array(MODEL_SIZE * MODEL_SIZE);
  for (let i = 0, p = 0; i < mData.length; i += 4, p++) {
    maskArr[p] = mData[i] > 127 ? 1 : 0;
  }

  onProgress?.('模型推理中', 0.93);
  const feeds = {
    image: new ort.Tensor('float32', imageArr, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    mask: new ort.Tensor('float32', maskArr, [1, 1, MODEL_SIZE, MODEL_SIZE]),
  };
  const results = await session.run(feeds);
  const outTensor = results[session.outputNames[0]];

  onProgress?.('合成结果', 0.96);
  const outImg = chwToImageData(outTensor.data, outTensor.dims, MODEL_SIZE, MODEL_SIZE);

  const outCanvas = createCanvas(MODEL_SIZE, MODEL_SIZE);
  outCanvas.getContext('2d').putImageData(outImg, 0, 0);

  // --- 贴回原图 ---
  return compositeBack(baseCanvas, outCanvas, maskBinary, crop, W, H);
}

/** 把 512 推理结果放大贴回原始画布的裁切区域，并按羽化遮罩融合 */
function compositeBack(baseCanvas, patchCanvas, maskBinary, crop, W, H) {
  const out = canvasFromSource(baseCanvas, W, H);
  const ctx = out.getContext('2d', { willReadFrequently: true });

  // 先把 patch 放大绘制到临时层（仅裁切区域大小）
  const patchScaled = createCanvas(crop.w, crop.h);
  const pctx = patchScaled.getContext('2d', { willReadFrequently: true });
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(patchCanvas, 0, 0, MODEL_SIZE, MODEL_SIZE, 0, 0, crop.w, crop.h);

  // 软遮罩：对遮罩做若干次盒式模糊，使边界自然过渡
  const soft = featherMask(maskBinary, crop, 2);

  const routine = ctx.getImageData(crop.x, crop.y, crop.w, crop.h);
  const pd = pctx.getImageData(0, 0, crop.w, crop.h).data;
  const sd = soft;
  const od = routine.data;

  for (let i = 0; i < od.length; i += 4) {
    const a = sd[i] / 255;
    if (a <= 0) continue;
    od[i] = pd[i] * a + od[i] * (1 - a);
    od[i + 1] = pd[i + 1] * a + od[i + 1] * (1 - a);
    od[i + 2] = pd[i + 2] * a + od[i + 2] * (1 - a);
  }
  ctx.putImageData(routine, crop.x, crop.y);
  return out;
}

/** 在裁切区域内生成羽化后的遮罩 alpha 数组 */
function featherMask(maskBinary, crop, blurPx) {
  const c = createCanvas(crop.w, crop.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(maskBinary, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

  const img = ctx.getImageData(0, 0, crop.w, crop.h);
  const d = img.data;
  // alpha 取自红通道
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i];
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  if (blurPx > 0) {
    // 多次盒式模糊近似高斯
    boxBlurAlpha(img.data, crop.w, crop.h, blurPx);
    boxBlurAlpha(img.data, crop.w, crop.h, blurPx);
  }
  return img.data;
}

function boxBlurAlpha(data, w, h, r) {
  const a = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) a[p] = data[i + 3];
  const tmp = new Uint8ClampedArray(w * h);
  // 横向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = clamp(x + k, 0, w - 1);
        s += a[y * w + xx]; n++;
      }
      tmp[y * w + x] = s / n;
    }
  }
  // 纵向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = clamp(y + k, 0, h - 1);
        s += tmp[yy * w + x]; n++;
      }
      data[(y * w + x) * 4 + 3] = s / n;
    }
  }
}

/** 取二值遮罩的外接矩形 */
export function bboxOfMask(maskBinary, W, H) {
  const d = maskBinary.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(row + x) * 4] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ============================================================
   快速引擎：多尺度邻域扩散填充（纯 JS）
   思路：先在低分辨率上把未知区域由外向内逐层加权填充，
        逐级上采样细化，最后在原分辨率收敛并羽化合成。
   ============================================================ */

/**
 * @param {HTMLCanvasElement} baseCanvas
 * @param {HTMLCanvasElement} maskBinary
 * @param {(msg:string,p:number)=>void} onProgress
 */
export function fastInpaint(baseCanvas, maskBinary, onProgress) {
  const W = baseCanvas.width, H = baseCanvas.height;
  const ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
  const baseImg = ctx.getImageData(0, 0, W, H);
  const mData = maskBinary.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, W, H).data;

  // 未知像素集合（known=0 表示待填充）
  const known = new Uint8Array(W * H);
  let unknownCount = 0;
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const isHole = mData[i] > 127;
    known[p] = isHole ? 0 : 1;
    if (isHole) unknownCount++;
  }
  if (!unknownCount) return canvasFromSource(baseCanvas, W, H);

  const rgb = new Float32Array(W * H * 3);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    rgb[p * 3] = baseImg.data[i];
    rgb[p * 3 + 1] = baseImg.data[i + 1];
    rgb[p * 3 + 2] = baseImg.data[i + 2];
  }

  // ---- 构建金字塔（最粗层控制在 ~512 以内）----
  const levels = [];
  let lw = W, lh = H;
  while (Math.max(lw, lh) > 560) {
    lw = Math.max(1, Math.ceil(lw / 2));
    lh = Math.max(1, Math.ceil(lh / 2));
    levels.push({ w: lw, h: lh });
  }
  levels.reverse(); // 由粗到细

  let cur = { rgb, known, w: W, h: H };
  const coarseChain = [];
  for (const lv of levels) {
    coarseChain.push(downsample(cur, lv.w, lv.h));
    cur = coarseChain[coarseChain.length - 1];
  }

  // ---- 由粗到细逐级填充并上采样 ----
  const total = coarseChain.length + 1;
  let stage = 0;
  for (let idx = coarseChain.length - 1; idx >= 0; idx--) {
    onProgress?.(`快速填充 ${Math.round((++stage) / total * 100)}%`, stage / total);
    fillDiffusion(coarseChain[idx]);
  }

  onProgress?.('细节收敛', 0.95);
  // ---- 原分辨率：用最细层上采样结果作为初值继续迭代 ----
  const finest = coarseChain[0];
  const refined = upsampleTo(finest, W, H);
  mergeGuess({ rgb, known, w: W, h: H }, refined, W, H);
  fillDiffusion({ rgb, known, w: W, h: H });

  // ---- 写回并与原图羽化合成 ----
  onProgress?.('合成结果', 0.98);
  return writeBackAndComposite(baseImg, rgb, known, W, H, mData);
}

/** 下采样一层：rgb 盒式均值，known 取 AND（任一未知则未知） */
function downsample(src, w, h) {
  const { w: sw, h: sh, rgb: srgb, known: sknown } = src;
  const rgb = new Float32Array(w * h * 3);
  const known = new Uint8Array(w * h);
  const rx = sw / w, ry = sh / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * ry), y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * ry)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * rx), x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * rx)));
      let r = 0, g = 0, b = 0, n = 0, k = 1;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const sp = yy * sw + xx;
          if (!sknown[sp]) { k = 0; continue; }
          r += srgb[sp * 3]; g += srgb[sp * 3 + 1]; b += srgb[sp * 3 + 2];
          n++;
        }
      }
      const dp = y * w + x;
      if (n > 0) {
        rgb[dp * 3] = r / n; rgb[dp * 3 + 1] = g / n; rgb[dp * 3 + 2] = b / n;
      }
      known[dp] = k && n > 0 ? 1 : 0;
    }
  }
  return { rgb, known, w, h };
}

/** 上采样一层（双线性）到目标尺寸 */
function upsampleTo(src, w, h) {
  const { w: sw, h: sh, rgb: srgb, known: sknown } = src;
  const rgb = new Float32Array(w * h * 3);
  const known = new Uint8Array(w * h);
  const rx = sw / w, ry = sh / h;

  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * ry - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * rx - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1);
      const wx = sx - x0;
      // 若任一角不明则该点视为不明，交由下一轮扩散决定
      const k00 = sknown[y0 * sw + x0], k01 = sknown[y0 * sw + x1];
      const k10 = sknown[y1 * sw + x0], k11 = sknown[y1 * sw + x1];
      const dp = y * w + x;
      for (let c = 0; c < 3; c++) {
        const v00 = srgb[(y0 * sw + x0) * 3 + c], v01 = srgb[(y0 * sw + x1) * 3 + c];
        const v10 = srgb[(y1 * sw + x0) * 3 + c], v11 = srgb[(y1 * sw + x1) * 3 + c];
        const top = v00 * (1 - wx) + v01 * wx;
        const bot = v10 * (1 - wx) + v11 * wx;
        rgb[dp * 3 + c] = top * (1 - wy) + bot * wy;
      }
      known[dp] = (k00 && k01 && k10 && k11) ? 1 : 0;
    }
  }
  return { rgb, known, w, h };
}

/** 把上采样的猜测值填入仍是未知的位置 */
function mergeGuess(target, guess, W, H) {
  const { known } = target;
  for (let p = 0; p < W * H; p++) {
    if (!known[p]) {
      target.rgb[p * 3] = guess.rgb[p * 3];
      target.rgb[p * 3 + 1] = guess.rgb[p * 3 + 1];
      target.rgb[p * 3 + 2] = guess.rgb[p * 3 + 2];
    }
  }
}

/**
 * 邻域扩散：由已知边界向未知内部逐层加权填充。
 * 每填充一个像素立即生效，形成自然的梯度过渡。
 */
function fillDiffusion({ rgb, known, w, h }) {
  const queue = new Int32Array(w * h);
  const inQ = new Uint8Array(w * h);
  let head = 0, tail = 0;

  const pushIfUnknown = (idx) => {
    if (!known[idx] && !inQ[idx]) { queue[tail++] = idx; inQ[idx] = 1; }
  };

  // 初始：所有与已知相邻的未知点
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (known[p]) continue;
      if (hasKnownNeighbor(known, x, y, w, h)) pushIfUnknown(p);
    }
  }

  // 8 邻域权重（去掉中心）
  const DX = [-1, -1, -1, 0, 0, 1, 1, 1];
  const DY = [-1, 0, 1, -1, 1, -1, 0, 1];
  const WT = [1, 2, 1, 2, 2, 1, 2, 1];

  let filled = 0;
  const totalUnknown = countUnknown(known);
  let guard = 0;
  const maxGuard = totalUnknown * 8 + 16;

  while (head < tail && guard++ < maxGuard) {
    const p = queue[head++];
    if (known[p]) continue;
    const x = p % w, y = (p / w) | 0;

    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (!known[np]) { pushIfUnknown(np); continue; }
      const wt = WT[k];
      sr += rgb[np * 3] * wt;
      sg += rgb[np * 3 + 1] * wt;
      sb += rgb[np * 3 + 2] * wt;
      sw += wt;
    }
    if (sw === 0) continue; // 仍无已知邻居，等待其他点推进后会再次入队

    rgb[p * 3] = sr / sw;
    rgb[p * 3 + 1] = sg / sw;
    rgb[p * 3 + 2] = sb / sw;
    known[p] = 1;
    filled++;

    // 通知邻居
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      pushIfUnknown(ny * w + nx);
    }
  }

  // 兜底：极端孤立的点用全图均值填充
  if (filled < totalUnknown) {
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (let p = 0; p < w * h; p++) {
      if (!known[p]) continue;
      mr += rgb[p * 3]; mg += rgb[p * 3 + 1]; mb += rgb[p * 3 + 2]; n++;
    }
    if (n) {
      mr /= n; mg /= n; mb /= n;
      for (let p = 0; p < w * h; p++) {
        if (known[p]) continue;
        rgb[p * 3] = mr; rgb[p * 3 + 1] = mg; rgb[p * 3 + 2] = mb;
        known[p] = 1;
      }
    }
  }
}

function hasKnownNeighbor(known, x, y, w, h) {
  const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
  const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
  for (let yy = y0; yy <= y1; yy++)
    for (let xx = x0; xx <= x1; xx++)
      if (known[yy * w + xx]) return true;
  return false;
}

function countUnknown(known) {
  let n = 0;
  for (let i = 0; i < known.length; i++) if (!known[i]) n++;
  return n;
}

/** 把填充结果按羽化遮罩融合回原图 */
function writeBackAndComposite(baseImg, rgb, known, W, H, maskData) {
  const out = new ImageData(W, H);
  const od = out.data, bd = baseImg.data;

  // 生成软遮罩（取 maskData 红通道做盒式模糊）
  const soft = new Uint8ClampedArray(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) soft[p] = maskData[i];
  boxBlurGray(soft, W, H, 2);
  boxBlurGray(soft, W, H, 2);

  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const a = soft[p] / 255;
    if (a <= 0) {
      od[i] = bd[i]; od[i + 1] = bd[i + 1]; od[i + 2] = bd[i + 2]; od[i + 3] = bd[i + 3];
      continue;
    }
    od[i] = clamp(rgb[p * 3] * a + bd[i] * (1 - a), 0, 255);
    od[i + 1] = clamp(rgb[p * 3 + 1] * a + bd[i + 1] * (1 - a), 0, 255);
    od[i + 2] = clamp(rgb[p * 3 + 2] * a + bd[i + 2] * (1 - a), 0, 255);
    od[i + 3] = bd[i + 3];
  }

  const c = createCanvas(W, H);
  c.getContext('2d').putImageData(out, 0, 0);
  void known;
  return c;
}

function boxBlurGray(a, w, h, r) {
  const tmp = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = clamp(x + k, 0, w - 1);
        s += a[y * w + xx]; n++;
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = clamp(y + k, 0, h - 1);
        s += tmp[yy * w + x]; n++;
      }
      a[y * w + x] = s / n;
    }
  }
}
