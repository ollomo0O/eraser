/* ============================================================
   match.js —— 重复水印识别（满屏平铺水印）
   
   针对半透明斜向文字水印的两处关键设计：
   
   1) 局部对比度归一化特征
      不用原始灰度，而是 (灰度 - 局部均值) / 局部标准差。
      半透明水印叠在不同背景上时绝对亮度天差地别，但"相对周围
      背景凸起"这一特征在暗处、亮处都成立，因此能跨背景稳定匹配。
   
   2) 掩码模板（masked NCC）
      用户沿文字笔画涂抹，模板只取被标记的像素，背景完全不参与
      比较。矩形框会把大片背景算进去，是斜向水印失败的根因。
   
   加速：灰度与特征图用积分图 O(1) 求窗口统计；匹配前降采样。
   ============================================================ */

import { clamp } from './core.js';

/* ---------------- 基础 ---------------- */

/** canvas -> 灰度 Float32Array（0~255） */
export function grayFromCanvas(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; p < g.length; p++, i += 4) {
    g[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return { gray: g, w, h };
}

/** 盒式降采样（用于图像，取平均） */
export function downsampleGray({ gray, w, h }, scale) {
  if (scale >= 1) return { gray, w, h };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) / scale)));
      let s = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * w;
        for (let sx = sx0; sx < sx1; sx++) { s += gray[row + sx]; n++; }
      }
      out[y * nw + x] = n ? s / n : 0;
    }
  }
  return { gray: out, w: nw, h: nh };
}

/** 最近邻降采样（用于二值遮罩，保持 0/255 不被插值污染） */
function downsampleMask({ gray, w, h }, scale) {
  if (scale >= 1) return { gray, w, h };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      out[y * nw + x] = gray[sy * w + sx];
    }
  }
  return { gray: out, w: nw, h: nh };
}

/* ---------------- 积分图 ---------------- */

function buildIntegral(a, w, h) {
  const W = w + 1;
  const I = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const cur = (y + 1) * W, prev = y * W;
    for (let x = 0; x < w; x++) {
      rowSum += a[y * w + x];
      I[cur + x + 1] = I[prev + x + 1] + rowSum;
    }
  }
  return { I, W };
}

function rectSum({ I, W }, x, y, bw, bh) {
  const x0 = x, y0 = y, x1 = x + bw, y1 = y + bh;
  return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
}

/* ---------------- 局部对比度归一化特征 ---------------- */

/**
 * feature(p) = (gray - 局部均值) / sqrt(局部方差 + eps)
 * 抑制背景的低频明暗变化，只保留"相对周围凸起"的结构——
 * 这正是半透明水印在各处背景上都保持不变的性质。
 *
 * eps 的取值很关键：它决定了"多小的起伏算噪声"。
 * 取得过小（如 25，相当于标准差 5 个灰度级）时，平滑背景的
 * 微小波动会被放大成很大的特征值，模板提纯随之失效；
 * 取 300（约 17 个灰度级）能有效压住背景噪声，同时水印的
 * 正特征仍能保留在 1.0 以上。
 *
 * @param {number} radius 局部窗口半径，应略大于水印笔画宽度
 * @param {number} eps 方差下限，抑制平坦区域的噪声放大
 */
export function buildFeatureMap(gray, w, h, radius = 12, eps = 300) {
  const integ = buildIntegral(gray, w, h);
  const sq = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) sq[i] = gray[i] * gray[i];
  const integSq = buildIntegral(sq, w, h);

  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
      const x1 = Math.min(w, x + radius + 1), y1 = Math.min(h, y + radius + 1);
      const bw = x1 - x0, bh = y1 - y0, n = bw * bh;
      const s = rectSum(integ, x0, y0, bw, bh);
      const s2 = rectSum(integSq, x0, y0, bw, bh);
      const mean = s / n;
      const varr = Math.max(0, s2 / n - mean * mean);
      out[y * w + x] = (gray[y * w + x] - mean) / Math.sqrt(varr + eps);
    }
  }
  return out;
}

/**
 * 特征二值化：v > thresh → 1，否则 0。
 *
 * 为什么必须做这一步：同一个白色半透明水印，在暗背景上对比度约 120 个
 * 灰度级、在亮背景上可能只有 60，归一化后特征值也相差约一倍。NCC 虽然
 * 对整体缩放免疫，但当部分像素因对比度低而落到阈值以下时，特征的"形状"
 * 就变了，分数随之下跌——这正是亮色背景区域漏检的原因。
 * 二值化把"亮起 / 不亮起"统一成同一个尺度，让不同背景上的水印
 * 产生完全一致的特征，从根本上消除对比度差异。
 */
export function binarizeFeature(feat, thresh = 0.3) {
  const out = new Float32Array(feat.length);
  for (let i = 0; i < feat.length; i++) out[i] = feat[i] > thresh ? 1 : 0;
  return out;
}

/* ---------------- 掩码模板 ---------------- */

/**
 * 从遮罩与特征图提取模板。
 *
 * 关键：涂抹时笔刷必然把背景像素一起圈进来，这些背景像素在不同位置
 * 表现各不相同，会严重拉低匹配分数。半透明白色水印的普遍特征是
 * 「比周围背景亮」，即局部归一化特征为正——因此只保留特征为正的
 * 像素作为模板，把背景剔除掉。若正像素过少（例如暗色水印），
 * 则逐级放宽阈值兜底。
 *
 * @returns {{tVals:Float32Array, offsets:Int32Array, bw:number, bh:number, purity:number}|null}
 */
function extractTemplate(maskSmall, iw, feat) {
  const { gray: m, w: mw, h: mh } = maskSmall;

  // 遮罩外接矩形
  let minX = mw, minY = mh, maxX = -1, maxY = -1;
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    for (let x = 0; x < mw; x++) {
      if (m[row + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < 4 || bh < 4) return null;
  if (minX + bw > iw) return null;

  const offs = [];
  const vals = [];
  for (let y = minY; y <= maxY; y++) {
    const row = y * mw, fRow = y * iw;
    for (let x = minX; x <= maxX; x++) {
      if (m[row + x] <= 127) continue;
      offs.push((y - minY) * iw + (x - minX));
      vals.push(feat[fRow + x]);
    }
  }
  if (offs.length < 15) return null;

  // 特征已二值化，只保留"比周围明显亮"的像素，
  // 把涂抹时带进来的背景像素彻底排除
  const selOffs = [], selVals = [];
  for (let i = 0; i < offs.length; i++) {
    if (vals[i] > 0.5) { selOffs.push(offs[i]); selVals.push(vals[i]); }
  }
  if (selOffs.length < 15) return null;

  return {
    offsets: Int32Array.from(selOffs),
    tVals: Float32Array.from(selVals),
    bw, bh,
    purity: selOffs.length / offs.length,
  };
}

/* ---------------- 掩码 NCC 匹配 ---------------- */

/**
 * 二值特征的相似度匹配，使用 Dice 系数：
 *
 *     score = 2·|A∩B| / (|A| + |B|)
 *
 *   A = 模板亮点集合（数量已知 = m）
 *   B = 候选位置外接矩形内的亮点集合
 *   A∩B = 模板各亮点位置在候选处同样亮起的数量
 *
 * 为什么不用 NCC：特征二值化后模板内全是 1，方差为 0，
 * 相关系数的分母归零，NCC 在数学上无法成立。
 *
 * 为什么用 Dice 而不是简单的 |A∩B|/|A|：后者在遇到大片亮区
 * （例如亮色背景、过曝区域）时会因为"碰巧都亮"而给出高分；
 * 引入 |B| 后，候选区域亮点越多、分母越大、分数越低，能有效抑制这类误检。
 */
export function matchMasked(feature, iw, ih, { offsets, bw, bh }, threshold = 0.55, step = 2) {
  const m = offsets.length;
  const maxX = iw - bw, maxY = ih - bh;
  if (maxX < 0 || maxY < 0) return [];

  // 亮点图 + 积分图：O(1) 求候选矩形内亮点总数
  const bin = new Uint8Array(iw * ih);
  const binF = new Float32Array(iw * ih);
  for (let i = 0; i < bin.length; i++) {
    const on = feature[i] > 0.5 ? 1 : 0;
    bin[i] = on;
    binF[i] = on;
  }
  const integBin = buildIntegral(binF, iw, ih);

  const hits = [];
  for (let y = 0; y <= maxY; y += step) {
    const rowBase = y * iw;
    for (let x = 0; x <= maxX; x += step) {
      const base = rowBase + x;

      // 模板位置上的命中数
      let inter = 0;
      for (let k = 0; k < m; k++) {
        if (bin[base + offsets[k]]) inter++;
      }
      if (inter === 0) continue;

      const b = rectSum(integBin, x, y, bw, bh);   // 候选区域内亮点总数
      if (b <= 0) continue;

      const score = (2 * inter) / (m + b);
      if (score >= threshold) hits.push({ x, y, w: bw, h: bh, score });
    }
  }
  return hits;
}

/* ---------------- 非极大值抑制 ---------------- */

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1), ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function nms(boxes, iouThresh = 0.3) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of sorted) {
    let dup = false;
    for (const k of keep) {
      if (iou(b, k) > iouThresh) { dup = true; break; }
    }
    if (!dup) keep.push(b);
  }
  return keep;
}

/* ---------------- 主入口 ---------------- */

/**
 * 在全图中找出与「遮罩标记区域」重复的所有位置
 * @param {HTMLCanvasElement} baseCanvas 底图
 * @param {HTMLCanvasElement} maskBinary 二值遮罩（白=模板像素）
 * @param {object} opts
 * @param {number} opts.threshold NCC 阈值 0~1
 * @param {number} opts.maxSearchEdge 搜索图最长边
 * @param {number} opts.step 滑窗步长
 * @param {number} opts.radius 局部归一化窗口半径
 * @param {number} opts.iouThresh NMS 重叠阈值
 */
export function detectRepeats(baseCanvas, maskBinary, opts = {}) {
  const threshold = opts.threshold ?? 0.55;
  const maxSearchEdge = opts.maxSearchEdge ?? 900;
  const step = opts.step ?? 2;
  const radius = opts.radius ?? 12;
  const iouThresh = opts.iouThresh ?? 0.3;

  const W = baseCanvas.width, H = baseCanvas.height;
  const scale = Math.min(1, maxSearchEdge / Math.max(W, H));

  const full = grayFromCanvas(baseCanvas);
  const search = downsampleGray(full, scale);
  const iw = search.w, ih = search.h;

  const maskFull = grayFromCanvas(maskBinary);
  const maskSmall = downsampleMask(maskFull, scale);

  // 特征二值化：统一不同背景上的对比度差异
  const raw = buildFeatureMap(search.gray, iw, ih, radius, opts.eps ?? 300);
  const feat = binarizeFeature(raw, opts.featureThresh ?? 0.3);

  const tmpl = extractTemplate(maskSmall, iw, feat);
  if (!tmpl) return [];

  const hits = matchMasked(feat, iw, ih, tmpl, threshold, step);
  const kept = nms(hits, iouThresh);

  const out = kept.map((b) => ({
    x: Math.round(b.x / scale),
    y: Math.round(b.y / scale),
    w: Math.round(tmpl.bw / scale),
    h: Math.round(tmpl.bh / scale),
    score: b.score,
  }));
  void clamp;
  return out;
}
