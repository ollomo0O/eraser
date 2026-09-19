/* ============================================================
   watermark.js —— 水印合成：文字水印 / Logo 水印 / 满屏平铺
   ============================================================ */

import { createCanvas, canvasFromSource, loadImageFromFile } from './core.js';

/** 根据图片宽度推荐一个视觉合适的默认字号 */
export function suggestFontSize(imgW) {
  return Math.max(10, Math.round(imgW / 32));
}

/**
 * 在已有 canvas 上合成水印
 * @param {HTMLCanvasElement} baseCanvas 底图（原始尺寸）
 * @param {object} s state.wmSettings
 * @param {'text'|'logo'} type
 * @returns {HTMLCanvasElement} 新 canvas
 */
export function applyWatermark(baseCanvas, s, type = 'text') {
  const W = baseCanvas.width, H = baseCanvas.height;
  const out = canvasFromSource(baseCanvas, W, H);
  const ctx = out.getContext('2d', { willReadFrequently: true });

  if (type === 'logo') {
    if (!s.logoCanvas) return out;
    drawLogoWatermark(ctx, s, W, H);
  } else {
    if (!s.text?.trim()) return out;
    drawTextWatermark(ctx, s, W, H);
  }
  return out;
}

/* ---------------- 文字水印 ---------------- */

function drawTextWatermark(ctx, s, W, H) {
  const {
    text, size, opacity, color, angle, font,
    position, padX, padY, tileX, tileY, shadow,
  } = s;

  ctx.save();
  ctx.globalAlpha = opacity / 100;
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';

  const rad = (angle * Math.PI) / 180;
  const lines = String(text).split('\n');

  if (position === 'tile') {
    // 满屏平铺：旋转坐标系后覆盖足够大的范围
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rad);
    const R = Math.sqrt(W * W + H * H) / 2 + size * 2;
    const lineH = size * 1.35;
    for (let ly = -R; ly <= R; ly += tileY) {
      for (let lx = -R; lx <= R; lx += tileX) {
        lines.forEach((ln, i) => {
          const y = ly + i * lineH;
          if (shadow) strokeLine(ctx, ln, lx, y);
          ctx.fillText(ln, lx, y);
        });
      }
    }
  } else {
    ctx.textAlign = position.includes('right') ? 'right' : position.includes('left') ? 'left' : 'center';
    const pos = anchorPoint(position, W, H, padX, padY);
    ctx.translate(pos.x, pos.y);
    ctx.rotate(rad);
    const lineH = size * 1.35;
    const totalH = (lines.length - 1) * lineH;
    lines.forEach((ln, i) => {
      const y = i * lineH - totalH / 2 + size / 2;
      if (shadow) strokeLine(ctx, ln, 0, y);
      ctx.fillText(ln, 0, y);
    });
  }
  ctx.restore();
}

function strokeLine(ctx, text, x, y) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = Math.max(1.5, parseFloat(ctx.font) / 14);
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.restore();
}

/* ---------------- Logo 水印 ---------------- */

function drawLogoWatermark(ctx, s, W, H) {
  const { logoCanvas, logoScale, logoOpacity, logoAngle, position, padX, padY, tileX, tileY } = s;
  const natural = logoCanvas;

  // 目标宽度按图片宽度的百分比
  const baseW = (W * logoScale) / 100;
  const ratio = natural.height / natural.width || 1;
  const dw = baseW;
  const dh = baseW * ratio;

  ctx.save();
  ctx.globalAlpha = logoOpacity / 100;
  const rad = (logoAngle * Math.PI) / 180;

  if (position === 'tile') {
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rad);
    const R = Math.sqrt(W * W + H * H) / 2 + Math.max(dw, dh);
    const stepX = Math.max(dw + 20, tileX);
    const stepY = Math.max(dh + 20, tileY);
    for (let y = -R; y <= R; y += stepY) {
      for (let x = -R; x <= R; x += stepX) {
        ctx.drawImage(natural, x, y, dw, dh);
      }
    }
  } else {
    const anchor = anchorPoint(position, W, H, padX, padY);
    ctx.translate(anchor.x, anchor.y);
    ctx.rotate(rad);
    // 以锚点为中心绘制
    ctx.drawImage(natural, -dw / 2, -dh / 2, dw, dh);
  }
  ctx.restore();
}

/* ---------------- 位置锚点 ---------------- */

function anchorPoint(position, W, H, padX, padY) {
  switch (position) {
    case 'top-left': return { x: padX, y: padY };
    case 'top-right': return { x: W - padX, y: padY };
    case 'bottom-left': return { x: padX, y: H - padY };
    case 'bottom-right': return { x: W - padX, y: H - padY };
    case 'center':
    default: return { x: W / 2, y: H / 2 };
  }
}

/* ---------------- Logo 载入 ---------------- */

/** 从 File 读取并生成规范化后的 logo canvas */
export async function loadLogoCanvas(file) {
  const img = await loadImageFromFile(file);
  const c = createCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  return { canvas: c, name: file.name, width: c.width, height: c.height };
}
