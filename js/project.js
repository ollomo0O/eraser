/* ============================================================
   project.js —— 项目文件存档（保存 / 加载）
   纯前端 JSON 包，含底图、遮罩、水印设置，便于中断后续接
   ============================================================ */

import {
  state, canvasToDataURL, canvasToBlob, downloadBlob, toast, sleep,
} from './core.js';

const FORMAT = 'eraser-watermark-project';
const VERSION = 1;

/**
 * 导出当前工作区为项目文件并下载
 * @param {import('./mask.js').MaskBoard} board
 */
export async function saveProject(board, batchBoard) {
  if (!state.sourceImage) { toast('尚未载入图片', 'error'); return; }

  const base = board.baseAsCanvas;
  const payload = {
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    fileName: state.fileName,
    image: canvasToDataURL(base, 'image/png'),
    mask: canvasToDataURL(canvasAlphaFix(board.getMaskBinaryCanvas()), 'image/png'),
    result: state.resultCanvas ? canvasToDataURL(state.resultCanvas, 'image/png') : null,
    settings: {
      tab: state.tab,
      tool: state.tool,
      brushSize: state.brushSize,
      engine: state.engine,
      wmType: state.wmType,
      wmSettings: {
        // 剔除不可序列化的 logo canvas
        ...state.wmSettings,
        logoCanvas: null,
        logoName: state.wmSettings.logoName || '',
      },
      batchEngine: state.batchEngine,
    },
    batchMask: batchBoard?.hasMask?.()
      ? canvasToDataURL(canvasAlphaFix(batchBoard.getMaskBinaryCanvas()), 'image/png')
      : null,
  };

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const name = `${state.fileName.replace(/\.[^.]+$/, '')}_项目存档.json`;
  downloadBlob(blob, name);
  toast('项目已保存，可在任何时间重新载入继续编辑', 'success');
}

/**
 * 读取项目文件
 * @returns {Promise<object|null>}
 */
export function readProject(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (data.format !== FORMAT) throw new Error('不是有效的项目文件');
        resolve(data);
      } catch (e) {
        reject(new Error('项目文件解析失败：' + e.message));
      }
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsText(file);
  });
}

/**
 * 把项目数据写回状态树
 * @param {object} data
 * @param {import('./mask.js').MaskBoard} board
 */
export function restoreProject(data, board, batchBoard) {
  const w = Math.max(1, Math.round(state.sourceImage?.width || 1));
  void w;

  if (data.settings) {
    const s = data.settings;
    if (s.tool) state.tool = s.tool;
    if (s.brushSize) state.brushSize = s.brushSize;
    if (s.engine) state.engine = s.engine;
    if (s.wmType) state.wmType = s.wmType;
    if (s.wmSettings) Object.assign(state.wmSettings, s.wmSettings);
    if (s.batchEngine) state.batchEngine = s.batchEngine;
  }
  void batchBoard;

  return {
    tab: data.settings?.tab || 'remove',
    fileName: data.fileName,
    mask: data.mask || null,
    result: data.result || null,
    board,
  };
}

/** 二值 canvas 转 PNG 前把 alpha 拉满，防止透明导致数据丢失 */
function canvasAlphaFix(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = 255;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export { canvasToBlob, downloadBlob, sleep };
