/* ============================================================
   app.js —— 主控制器：装配 UI、模式路由、处理流程
   ============================================================ */

import {
  state, $, $$, on, clamp, toast, applyTheme, toggleTheme,
  canvasFromFile, canvasFromSource, downloadCanvas, sleep,
  createCanvas, dataURLToCanvas, canvasToDataURL, fitWithin,
} from './core.js';
import { MaskBoard } from './mask.js';
import { aiInpaint, fastInpaint, ensureModel, clearModel, isModelReady } from './inpaint.js';
import { applyWatermark, loadLogoCanvas, suggestFontSize } from './watermark.js';
import { BatchManager } from './batch.js';
import { saveProject, readProject, restoreProject } from './project.js';
import { detectRepeats } from './match.js';

/* ---------------- 画板实例 ---------------- */
const board = new MaskBoard({
  wrap: $('#canvasWrap'),
  base: $('#baseCanvas'),
  mask: $('#maskCanvas'),
  draw: $('#drawCanvas'),
  onChange: () => {
    // 马赛克编辑会改动底图，需要同步到基准画布
    if (state.tool === 'mosaic' && !state.resultCanvas) syncClean();
    // 矩形预览会清空绘制层，需重绘识别框
    if (state.match.active) renderMatches();
    updateRemovePanel();
  },
});

const batch = new BatchManager({
  onUpdate: () => renderBatchList(),
  modelProgress: () => {},
});

/** 当前基准图像：所有处理的输入，不含对比视图 */
state.cleanCanvas = null;

/** 全局水印识别（满屏平铺）状态 */
state.match = { active: false, boxes: [], threshold: 0.5 };

function syncClean() {
  state.cleanCanvas = board.baseAsCanvas;
}

/* ============================================================
   启动
   ============================================================ */
init();

function init() {
  applyTheme(state.theme);
  bindTopbar();
  bindSidebar();
  bindStage();
  bindRemovePanel();
  bindWatermarkPanel();
  bindBatchPanel();
  bindProjectIO();
  bindShortcuts();
  setTool(state.tool);
  updateModelUI('idle', '尚未加载');
  updateZoomLabel();
  renderBatchList();
  switchTab(state.tab);
}

/* ============================================================
   顶部栏
   ============================================================ */
function bindTopbar() {
  on($('#themeToggle'), 'click', toggleTheme);

  $$('#tabs .tab').forEach((btn) => {
    on(btn, 'click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  state.tab = tab;
  $$('#tabs .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  $$('.panel-section').forEach((s) => s.classList.toggle('is-active', s.dataset.panel === tab));
  $$('[data-only]').forEach((el) => {
    el.hidden = el.dataset.only !== tab;
  });

  if (tab === 'add') {
    setTool(state.wmType === 'mosaicTool' ? 'mosaic' : 'brush');
  } else {
    setTool(state.tool === 'mosaic' ? 'brush' : state.tool);
  }
  renderStage();
  updateRemovePanel();
}

/* ============================================================
   左侧工具栏
   ============================================================ */
function bindSidebar() {
  const single = $('#fileInput');
  on($('#btnPickImage'), 'click', () => single.click());
  on($('#btnPickImage2'), 'click', () => single.click());
  on(single, 'change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await loadFile(f);
    single.value = '';
  });

  $$('[data-tool]').forEach((btn) => {
    on(btn, 'click', () => {
      setTool(btn.dataset.tool);
      state.tool = btn.dataset.tool;
    });
  });

  const brushRange = $('#brushSize');
  on(brushRange, 'input', () => {
    state.brushSize = +brushRange.value;
    $('#brushSizeVal').textContent = brushRange.value;
    board.brushSize = state.brushSize;
    batch.board.brushSize = state.brushSize;
  });
  board.brushSize = state.brushSize;
  batch.board.brushSize = state.brushSize;

  on($('#btnUndo'), 'click', () => {
    if (board.undo()) { toast('已撤销'); renderStage(); }
    else toast('没有可撤销的操作');
  });
  on($('#btnRedo'), 'click', () => {
    if (board.redo()) { toast('已重做'); renderStage(); }
    else toast('没有可重做的操作');
  });
  on($('#btnClearMask'), 'click', () => {
    board.clearMask(); toast('遮罩已清空');
  });

  on($('#toggleMaskView'), 'change', (e) => {
    state.showMask = e.target.checked;
    board.setShowMask(state.showMask);
  });

  // 缩放
  on($('#btnZoomIn'), 'click', () => zoomBy(1.25));
  on($('#btnZoomOut'), 'click', () => zoomBy(0.8));
  on($('#btnFit'), 'click', () => { state.zoom = null; fitView(); });
  window.addEventListener('resize', () => { if (!state.zoom) fitView(); });
}

function zoomBy(k) {
  if (!board.width) return;
  const base = state.zoom ?? board.zoom;
  const z = clamp(base * k, 0.02, 8);
  state.zoom = z;
  board.setZoom(z);
  updateZoomLabel();
}

function fitView() {
  if (!board.width) return;
  board.fitInto($('#canvasScroll'));
  updateZoomLabel();
}

function updateZoomLabel() {
  $('#zoomVal').textContent = state.zoom == null
    ? '自适应'
    : `${Math.round(board.zoom * 100)}%`;
}

function setTool(tool) {
  board.tool = tool;
  $$('[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
  document.body.className = '';
  if (tool === 'mosaic' || tool === 'eraser') document.body.classList.add(`tool-${tool}`);
}

/* ============================================================
   图片载入
   ============================================================ */
async function loadFile(file) {
  showOverlay('载入图片…');
  await sleep(0);   // 先让遮罩渲染出来，避免大图解码时界面看起来像卡死
  try {
    let canvas = await canvasFromFile(file);
    const fit = fitWithin(canvas.width, canvas.height);
    if (fit.w !== canvas.width) {
      canvas = canvasFromSource(canvas, fit.w, fit.h);
      toast(`为保证处理流畅，已缩放到 ${fit.w}×${fit.h}`, 'success', 3000);
    }
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    installImage(canvas);
    toast('图片已载入', 'success');
  } catch (e) {
    toast(e.message || '图片载入失败', 'error');
  } finally {
    hideOverlay();
  }
}

function installImage(canvas) {
  state.cleanCanvas = canvas;
  state.resultCanvas = null;
  state.sourceImage = canvas;
  board.setImage(canvas, canvas.width, canvas.height);
  board.setShowMask(state.showMask);
  batch.board.setShowMask(state.showMask);

  $('#emptyState').hidden = true;
  $('#canvasArea').hidden = false;
  $('#resultBlock').hidden = true;
  $('#compareBar').hidden = true;

  fitView();
  autoSuggestWatermarkSize();
  renderStage();
  updateRemovePanel();
  updateWatermarkBtn();
}

/* 拖拽与粘贴 */
function bindStage() {
  const stage = $('#stage');
  const hint = $('#dropHint');

  ['dragenter', 'dragover'].forEach((ev) => {
    on(stage, ev, (e) => { e.preventDefault(); hint.classList.add('show'); });
  });
  ['dragleave', 'dragend'].forEach((ev) => {
    on(stage, ev, (e) => {
      e.preventDefault();
      if (!stage.contains(e.relatedTarget)) hint.classList.remove('show');
    });
  });
  on(stage, 'drop', async (e) => {
    e.preventDefault();
    hint.classList.remove('show');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (state.tab === 'batch') { await batch.addFiles(files); switchTab('batch'); }
    else await loadFile(files[0]);
  });

  on(document, 'paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgItem = items.find((i) => i.type.startsWith('image/'));
    if (!imgItem) return;
    const f = imgItem.getAsFile();
    if (f) { await loadFile(f); toast('已从剪贴板载入', 'success'); }
  });

  // 对比滑块
  bindCompare();
}

function bindCompare() {
  const track = $('#compareTrack');
  const handle = $('#compareHandle');
  let dragging = false;

  const setRatio = (clientX) => {
    const r = track.getBoundingClientRect();
    state.compareRatio = clamp((clientX - r.left) / r.width, 0, 1);
    handle.style.left = `${state.compareRatio * 100}%`;
    renderStage();
  };

  on(track, 'pointerdown', (e) => {
    dragging = true;
    setRatio(e.clientX);
  });
  on(handle, 'pointerdown', (e) => { e.stopPropagation(); dragging = true; });
  on(window, 'pointermove', (e) => { if (dragging) setRatio(e.clientX); });
  on(window, 'pointerup', () => { dragging = false; });
}

/* ============================================================
   舞台渲染
   ============================================================ */
function renderStage() {
  if (!state.cleanCanvas) return;
  const W = board.width, H = board.height;
  const ctx = board.baseCtx;
  ctx.clearRect(0, 0, W, H);

  if (state.tab === 'add' && state.wmPreview && state.wmType !== 'mosaicTool') {
    const wm = applyWatermark(state.cleanCanvas, state.wmSettings, state.wmType);
    ctx.drawImage(wm, 0, 0);
    return;
  }

  if (state.resultCanvas) {
    if (state.comparing) {
      const sx = W * state.compareRatio;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip();
      ctx.drawImage(state.resultCanvas, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip();
      ctx.drawImage(state.cleanCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(state.resultCanvas, 0, 0);
    }
    return;
  }
  ctx.drawImage(state.cleanCanvas, 0, 0);
}

/* ============================================================
   去除水印面板
   ============================================================ */
function bindRemovePanel() {
  // --- 全局水印识别 ---
  on($('#btnDetectRepeats'), 'click', runDetectRepeats);
  on($('#btnClearMatches'), 'click', () => clearMatches());
  on($('#btnApplyMatches'), 'click', applyMatches);

  const thRange = $('#matchThreshold');
  on(thRange, 'input', () => { $('#matchThVal').textContent = thRange.value; });
  // 松手后才重算，避免拖动过程中反复触发耗时匹配
  on(thRange, 'change', () => {
    state.match.threshold = +thRange.value / 100;
    if (state.match.active || board.hasMask()) runDetectRepeats();
  });

  $$('input[name="engine"]').forEach((r) => {
    on(r, 'change', () => {
      state.engine = r.value;
      $('#modelBlock').hidden = r.value !== 'ai';
      updateRemovePanel();
    });
  });

  on($('#btnLoadModel'), 'click', () => loadModel(false));
  on($('#btnClearModelCache'), 'click', async () => {
    await clearModel();
    updateModelUI('idle', '尚未加载');
    toast('模型缓存已清除');
  });

  on($('#btnRunRemove'), 'click', runRemove);

  on($('#btnDownloadResult'), 'click', async () => {
    if (!state.resultCanvas) return;
    await downloadCanvas(state.resultCanvas, `${state.fileName}_无水印.png`);
    toast('已下载', 'success');
  });
  on($('#btnUseResult'), 'click', () => {
    if (!state.resultCanvas) return;
    board.replaceBase(state.resultCanvas);
    state.cleanCanvas = state.resultCanvas;
    state.resultCanvas = null;
    board.clearMask(false);
    $('#resultBlock').hidden = true;
    $('#compareBar').hidden = true;
    renderStage();
    toast('已作为新底图，可继续标记其它水印');
    updateRemovePanel();
  });
  on($('#toggleCompare'), 'change', (e) => {
    state.comparing = e.target.checked;
    renderStage();
  });
}

/* ============================================================
   全局水印识别（满屏平铺水印）
   框选一个水印 → 全图 NCC 匹配 → 预览并增删 → 应用为遮罩
   ============================================================ */

async function runDetectRepeats() {
  if (!state.cleanCanvas) return;
  if (!board.hasMask()) {
    toast('请先用「画笔」沿文字笔画涂抹一个水印作为样本', 'error', 3600);
    return;
  }

  showOverlay('识别重复水印…', '正在全图比对，请稍候');
  await sleep(0);

  try {
    // 用遮罩（涂抹范围）而非矩形框作为模板，避免把大片背景算进去
    const mask = board.getMaskBinaryCanvas();
    const boxes = detectRepeats(state.cleanCanvas, mask, {
      threshold: state.match.threshold,
    });
    state.match.boxes = boxes;
    state.match.active = boxes.length > 0;
    renderMatches();
    updateMatchUI();

    if (!boxes.length) {
      toast('未找到重复区域，可尝试降低灵敏度或重框样本', 'error', 3600);
    } else {
      toast(`识别到 ${boxes.length} 处重复水印`, 'success');
    }
  } catch (e) {
    console.error(e);
    toast(e.message || '识别失败', 'error');
  } finally {
    hideOverlay();
  }
}

function clearMatches() {
  state.match.active = false;
  state.match.boxes = [];
  renderMatches();
  updateMatchUI();
}

/** 在绘制层画出识别框（绿色描边） */
function renderMatches() {
  if (!board.width) return;
  const ctx = board.drawCtx;
  ctx.clearRect(0, 0, board.width, board.height);
  if (!state.match.active || !state.match.boxes.length) return;

  ctx.save();
  ctx.strokeStyle = '#3fb950';
  ctx.lineWidth = Math.max(1, 2 / board.zoom);
  ctx.setLineDash([]);
  for (const b of state.match.boxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.restore();
}

function applyMatches() {
  const boxes = state.match.boxes;
  if (!boxes.length) return;
  board.fillMaskRects(boxes);
  const n = boxes.length;
  clearMatches();
  toast(`已将 ${n} 处标记为待修复区域`, 'success');
}

function updateMatchUI() {
  const n = state.match.boxes.length;
  const active = state.match.active && n > 0;
  $('#matchInfo').hidden = !active;
  $('#btnApplyMatches').hidden = !active;
  $('#btnClearMatches').hidden = !active;
  $('#matchCount').textContent = n;
  $('#btnApplyMatches').disabled = !active;
}

async function loadModel(auto) {
  updateModelUI('loading', auto ? '自动下载模型…' : '正在下载模型…', 0);
  $('#modelProgress').hidden = false;
  try {
    await ensureModel((p, loaded, total, stage) => {
      if (stage === 'cached') {
        updateModelUI('loading', '使用本地缓存…', 1);
      } else if (stage === 'init') {
        updateModelUI('loading', '初始化推理引擎…', 0.96);
      } else if (stage === 'download') {
        const mb = (n) => (n / 1048576).toFixed(1);
        setModelProgress(p, (total ? `${mb(loaded)} / ${mb(total)} MB` : '下载中'));
        updateModelUI('loading', '正在下载 AI 模型', p * 0.9);
      } else {
        setModelProgress(p, '');
      }
    });
    updateModelUI('ready', '模型已就绪');
    toast('AI 模型已就绪', 'success');
  } catch (e) {
    console.error(e);
    updateModelUI('error', e.message || '模型加载失败');
    $('#modelProgress').hidden = true;
    toast('模型加载失败，可改用「快速本地修复」', 'error', 4000);
  }
}

function setModelProgress(p, text) {
  $('#modelProgressBar').style.width = `${clamp(p, 0, 1) * 100}%`;
  $('#modelPct').textContent = text || `${Math.round(p * 100)}%`;
}

function updateModelUI(st, text, p) {
  const box = $('#modelState');
  box.dataset.state = st;
  $('#modelStatusText').textContent = text;
  if (p != null) $('#modelProgressBar').style.width = `${clamp(p, 0, 1) * 100}%`;
  if (st === 'ready') $('#modelProgress').hidden = true;
  if (st === 'error') {
    $('#modelHint').textContent = '模型加载失败。可重试，或切换到「快速本地修复」继续工作。';
  } else {
    $('#modelHint').textContent = '首次使用需从 CDN 下载约 200MB 模型，之后缓存在浏览器中，无需重复下载。';
  }
}

function updateRemovePanel() {
  const hasImg = !!state.cleanCanvas;
  const hasMask = hasImg && board.hasMask();
  const btn = $('#btnRunRemove');
  const hint = $('#removeHint');
  btn.disabled = !hasImg || !hasMask;
  $('#btnDetectRepeats').disabled = !hasImg || !hasMask;

  if (!hasImg) hint.textContent = '请先载入一张图片';
  else if (!hasMask) hint.textContent = '用画笔或矩形标记出水印区域（可多次叠加）';
  else if (state.engine === 'ai' && !isModelReady()) hint.textContent = '首次使用将下载 AI 模型约 200MB，请耐心等待';
  else hint.textContent = '点击「开始去除」，处理在本地完成';

  $('#btnUndo').disabled = !board.canUndo;
  $('#btnRedo').disabled = !board.canRedo;
}

async function runRemove() {
  if (!state.cleanCanvas || !board.hasMask()) return;
  // 标志位可能因橡皮把遮罩全部擦净而失准，真正执行前做一次精确校验
  if (!board.hasMaskExact()) {
    toast('当前没有标记任何水印区域', 'error');
    return;
  }

  const engine = state.engine;
  const input = state.cleanCanvas;
  const mask = board.getMaskBinaryCanvas();

  board.enabled = false;
  showOverlay(engine === 'ai' ? 'AI 修复中…' : '快速修复中…', '', true);

  try {
    const t0 = performance.now();
    const result = engine === 'ai'
      ? await aiInpaint(input, mask, (msg, p) => {
          $('#overlayTitle').textContent = msg;
          $('#overlayProgressBar').style.width = `${clamp(p, 0, 1) * 100}%`;
        })
      : await new Promise((resolve, reject) => {
          // 让出一帧以便渲染进度 UI
          requestAnimationFrame(() => {
            try {
              const r = fastInpaint(input, mask, (msg, p) => {
                $('#overlayTitle').textContent = msg;
                $('#overlayProgressBar').style.width = `${clamp(p, 0, 1) * 100}%`;
              });
              resolve(r);
            } catch (err) { reject(err); }
          });
        });

    state.resultCanvas = result;
    state.comparing = true;
    state.compareRatio = 0.5;
    $('#compareHandle').style.left = '50%';
    $('#toggleCompare').checked = true;
    $('#resultBlock').hidden = false;
    $('#compareBar').hidden = false;
    board.clearMask(false);
    renderStage();

    const cost = ((performance.now() - t0) / 1000).toFixed(1);
    await downloadCanvas(result, `${state.fileName}_无水印.png`);
    toast(`处理完成，耗时 ${cost}s，结果已下载`, 'success', 3600);
  } catch (e) {
    console.error(e);
    toast(e.message || '处理失败，请重试', 'error', 4000);
  } finally {
    board.enabled = true;
    hideOverlay();
    updateRemovePanel();
  }
}

/* ============================================================
   添加水印面板
   ============================================================ */
function bindWatermarkPanel() {
  $$('[data-wm]').forEach((btn) => {
    on(btn, 'click', () => setWatermarkType(btn.dataset.wm));
  });

  const bindRange = (id, key, valId, fmt = (v) => v) => {
    const el = $(id);
    on(el, 'input', () => {
      state.wmSettings[key] = +el.value;
      $(valId).textContent = fmt(+el.value);
      renderStage();
    });
  };

  const txt = $('#wmText');
  on(txt, 'input', () => {
    state.wmSettings.text = txt.value;
    renderStage();
  });
  bindRange('#wmSize', 'size', '#wmSizeVal');
  bindRange('#wmOpacity', 'opacity', '#wmOpacityVal');
  bindRange('#wmAngle', 'angle', '#wmAngleVal');
  bindRange('#logoScale', 'logoScale', '#logoScaleVal');
  bindRange('#logoOpacity', 'logoOpacity', '#logoOpacityVal');
  bindRange('#logoAngle', 'logoAngle', '#logoAngleVal');
  bindRange('#wmPadX', 'padX', '#wmPadXVal');
  bindRange('#wmPadY', 'padY', '#wmPadYVal');
  bindRange('#wmTileX', 'tileX', '#wmTileXVal');
  bindRange('#wmTileY', 'tileY', '#wmTileYVal');

  on($('#wmColor'), 'input', (e) => {
    state.wmSettings.color = e.target.value; renderStage();
  });
  on($('#wmFont'), 'change', (e) => {
    state.wmSettings.font = e.target.value; renderStage();
  });
  on($('#wmPosition'), 'change', (e) => {
    state.wmSettings.position = e.target.value;
    const tile = e.target.value === 'tile';
    $$('[data-not-tile]').forEach((el) => { el.hidden = tile; });
    $$('[data-only-tile]').forEach((el) => { el.hidden = !tile; });
    renderStage();
  });
  on($('#wmShadow'), 'change', (e) => {
    state.wmSettings.shadow = e.target.checked; renderStage();
  });
  on($('#wmPreview'), 'change', (e) => {
    state.wmPreview = e.target.checked; renderStage();
  });

  const logoInput = $('#logoInput');
  on($('#btnPickLogo'), 'click', () => logoInput.click());
  on(logoInput, 'change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const { canvas, name } = await loadLogoCanvas(f);
      state.wmSettings.logoCanvas = canvas;
      state.wmSettings.logoName = name;
      $('#logoPreview').hidden = false;
      $('#logoPreviewImg').src = canvasToDataURL(canvas);
      $('#logoName').textContent = name;
      renderStage();
      toast('Logo 已载入', 'success');
    } catch (err) {
      toast(err.message || 'Logo 读取失败', 'error');
    }
    logoInput.value = '';
  });

  on($('#btnApplyWatermark'), 'click', async () => {
    if (!state.cleanCanvas) return;
    let out = state.cleanCanvas;
    if (state.wmType !== 'mosaicTool') {
      out = applyWatermark(state.cleanCanvas, state.wmSettings, state.wmType);
    }
    await downloadCanvas(out, `${state.fileName}_已加水印.png`);
    toast('已导出', 'success');
  });

  setWatermarkType('text');
}

function setWatermarkType(type) {
  state.wmType = type;
  $$('[data-wm]').forEach((b) => b.classList.toggle('is-active', b.dataset.wm === type));
  $('[data-wmset="text"]').hidden = type !== 'text';
  $('[data-wmset="logo"]').hidden = type !== 'logo';
  $('[data-wmset="common"]').hidden = type === 'mosaicTool';

  if (type === 'mosaicTool') {
    state.tool = 'mosaic';
    setTool('mosaic');
    board.mosaicBlock = 10;
    if (state.tab !== 'add') switchTab('add');
  } else if (state.tab === 'add') {
    setTool('brush');
  }
  updateWatermarkBtn();
  renderStage();
}

function updateWatermarkBtn() {
  const btn = $('#btnApplyWatermark');
  btn.disabled = !state.cleanCanvas;
  btn.textContent = state.wmType === 'mosaicTool' ? '导出打码结果' : '应用并导出';
}

function autoSuggestWatermarkSize() {
  if (!state.cleanCanvas) return;
  const s = suggestFontSize(state.cleanCanvas.width);
  state.wmSettings.size = s;
  $('#wmSize').value = s;
  $('#wmSizeVal').textContent = s;
}

/* ============================================================
   批量面板
   ============================================================ */
function bindBatchPanel() {
  const multi = $('#fileInputMulti');
  on($('#btnPickBatch'), 'click', () => multi.click());
  on(multi, 'change', async (e) => {
    await batch.addFiles([...(e.target.files || [])]);
    multi.value = '';
  });

  on($('#btnClearBatchMask'), 'click', () => {
    batch.board.clearMask(false);
    renderBatchList();
  });

  $$('input[name="bEngine"]').forEach((r) => {
    on(r, 'change', () => { state.batchEngine = r.value; });
  });

  on($('#btnRunBatch'), 'click', async () => {
    const prog = $('#batchProgress');
    prog.hidden = false;
    batch.modelProgress = (msg, p) => {
      $('#batchProgressBar').style.width = `${clamp(p, 0, 1) * 100}%`;
      $('#batchProgressText').textContent = batch.summaryText;
    };
    await batch.runAll();
    prog.hidden = true;
    renderBatchList();
  });

  on($('#btnDownloadAll'), 'click', async () => {
    showOverlay('打包中…', '正在生成 ZIP');
    try { await batch.downloadZip(); } finally { hideOverlay(); }
  });
}

function renderBatchList() {
  const box = $('#batchList');
  $('#batchCount').textContent = batch.items.length;
  $('#btnRunBatch').disabled = !batch.items.length || !batch.hasMask() || batch.running;
  $('#btnDownloadAll').disabled = !batch.items.some((i) => i.status === 'done');
  $('#batchMaskInfo').textContent = batch.getBoundsText();
  $('#batchProgressText').textContent = batch.summaryText;

  if (!batch.items.length) {
    box.innerHTML = '<p class="hint center">尚未添加图片</p>';
    return;
  }

  box.innerHTML = '';
  batch.items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'batch-item';
    row.dataset.state = item.status;
    if (item.id === state.batchCurrentId) row.classList.add('is-current');

    const img = item.thumb || (item.thumb = makeThumb(item.canvas));
    const stateText = { pending: '待处理', running: item.message || '处理中', done: '完成', error: item.message || '失败' }[item.status];

    row.appendChild(Object.assign(document.createElement('img'), { src: img }));
    const name = document.createElement('div');
    name.className = 'bi-name';
    name.textContent = item.name;
    name.title = item.name;
    row.appendChild(name);

    const st = document.createElement('span');
    st.className = 'bi-state';
    st.textContent = stateText;
    row.appendChild(st);

    const del = document.createElement('button');
    del.className = 'bi-del';
    del.textContent = '✕';
    del.title = '移除';
    on(del, 'click', (e) => { e.stopPropagation(); batch.remove(item.id); });
    row.appendChild(del);

    on(row, 'click', () => batch.setCurrent(item.id));
    box.appendChild(row);
  });
}

function makeThumb(canvas) {
  const k = Math.min(48 / canvas.width, 48 / canvas.height, 1);
  const c = createCanvas(Math.max(1, Math.round(canvas.width * k)), Math.max(1, Math.round(canvas.height * k)));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/* ============================================================
   项目存档
   ============================================================ */
function bindProjectIO() {
  on($('#btnSaveProject'), 'click', () => saveProject(board, batch.board));

  const pi = $('#projectInput');
  on($('#btnLoadProject'), 'click', () => pi.click());
  on(pi, 'change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    pi.value = '';
    showOverlay('载入项目…');
    try {
      const data = await readProject(f);
      const img = await dataURLToCanvas(data.image);
      state.fileName = data.fileName || 'image';
      installImage(img);
      restoreProject(data, board, batch.board);
      if (data.mask) {
        const m = await dataURLToCanvas(data.mask);
        board.loadMaskBinaryCanvas(m);
      }
      if (data.result) state.resultCanvas = await dataURLToCanvas(data.result);
      // 还原 UI 控件
      const s = data.settings || {};
      if (s.engine) {
        state.engine = s.engine;
        $$('input[name="engine"]').forEach((r) => { r.checked = r.value === s.engine; });
        $('#modelBlock').hidden = s.engine !== 'ai';
      }
      if (s.brushSize) {
        $('#brushSize').value = s.brushSize;
        $('#brushSizeVal').textContent = s.brushSize;
        board.brushSize = +s.brushSize;
      }
      if (s.tool) setTool(s.tool === 'mosaic' ? 'brush' : s.tool);
      if (state.resultCanvas) {
        $('#resultBlock').hidden = false;
        $('#compareBar').hidden = false;
      }
      if (s.wmSettings) {
        applyWmSettingsToUI(s.wmSettings);
      }
      switchTab(s.tab || 'remove');
      renderStage();
      updateRemovePanel();
      toast('项目已载入', 'success');
    } catch (err) {
      toast(err.message || '项目载入失败', 'error');
    } finally {
      hideOverlay();
    }
  });
}

function applyWmSettingsToUI(s) {
  $('#wmText').value = s.text ?? '';
  const map = [
    ['#wmSize', 'size', '#wmSizeVal'],
    ['#wmOpacity', 'opacity', '#wmOpacityVal'],
    ['#wmAngle', 'angle', '#wmAngleVal'],
    ['#logoScale', 'logoScale', '#logoScaleVal'],
    ['#logoOpacity', 'logoOpacity', '#logoOpacityVal'],
    ['#logoAngle', 'logoAngle', '#logoAngleVal'],
    ['#wmPadX', 'padX', '#wmPadXVal'],
    ['#wmPadY', 'padY', '#wmPadYVal'],
    ['#wmTileX', 'tileX', '#wmTileXVal'],
    ['#wmTileY', 'tileY', '#wmTileYVal'],
  ];
  map.forEach(([id, key, valId]) => {
    if (s[key] == null) return;
    const el = $(id);
    if (el) { el.value = s[key]; $(valId).textContent = s[key]; }
  });
  if (s.color) $('#wmColor').value = s.color;
  if (s.font) $('#wmFont').value = s.font;
  if (s.position) {
    $('#wmPosition').value = s.position;
    const tile = s.position === 'tile';
    $$('[data-not-tile]').forEach((el) => { el.hidden = tile; });
    $$('[data-only-tile]').forEach((el) => { el.hidden = !tile; });
  }
  if (s.shadow != null) $('#wmShadow').checked = !!s.shadow;
  Object.assign(state.wmSettings, s);
}

/* ============================================================
   快捷键
   ============================================================ */
function bindShortcuts() {
  on(document, 'keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) return;

    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? board.redo() : board.undo();
      renderStage();
      return;
    }
    if (meta && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject(board, batch.board);
      return;
    }
    if (meta) return;

    const map = { b: 'brush', r: 'rect', e: 'eraser', m: 'mosaic' };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      state.tool = tool;
      setTool(tool);
    }
    if (e.key === '0') { state.zoom = null; fitView(); }
  });

  // 结果态下开始新的标记：自动把结果落到新的基准底图
  on($('#drawCanvas'), 'pointerdown', (e) => {
    // 识别预览态：点中某个框即可移除该误识别
    if (state.match.active) {
      const p = board._pos(e);
      const idx = state.match.boxes.findIndex(
        (b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
      );
      if (idx >= 0) {
        state.match.boxes.splice(idx, 1);
        if (!state.match.boxes.length) state.match.active = false;
        renderMatches();
        updateMatchUI();
        e.stopPropagation();   // 不让画板把这次点击当成新的涂抹
        return;
      }
    }
    if (state.resultCanvas) {
      board.replaceBase(state.resultCanvas);
      state.cleanCanvas = canvasFromSource(state.resultCanvas, board.width, board.height);
      state.resultCanvas = null;
      $('#resultBlock').hidden = true;
      $('#compareBar').hidden = true;
      board.clearMask(false);
      renderStage();
    }
  }, true);
}

/* ============================================================
   Overlay 辅助
   ============================================================ */
function showOverlay(title, desc = '', withProgress = false) {
  $('#overlayTitle').textContent = title;
  $('#overlayDesc').textContent = desc;
  $('#overlayProgressWrap').hidden = !withProgress;
  $('#overlayProgressBar').style.width = '0%';
  $('#stageOverlay').hidden = false;
}

function hideOverlay() {
  $('#stageOverlay').hidden = true;
}
