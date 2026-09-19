# Eraser · 图片水印处理

纯浏览器端的图片水印处理工具。**图片不会上传到任何服务器**，所有像素运算都在你的浏览器本地完成。

## 核心特性

**去除水印**
- 画笔涂抹 / 矩形框选 / 橡皮擦，支持多次叠加标记多个水印区域
- **全局水印识别（满屏平铺水印）**：用画笔沿笔画涂抹一个水印，自动定位全图所有重复位置
  - 局部对比度归一化 + 特征二值化：同一个半透明水印叠在暗处与亮处的对比度可差一倍，必须先统一尺度
  - Dice 二值特征匹配（纯二值特征下 NCC 方差为零、无法成立），积分图加速 + 降采样 + 非极大值抑制
  - 结果以绿框预览，点击任意框可移除误识别，确认后一键转为遮罩
  - 匹配灵敏度 35%~90% 可调：漏检就调低，误检多就调高
- 双修复引擎：
  - **AI 高质量**（LaMa big-lama ONNX 模型，理解语义结构，复杂背景也能自然衔接）
  - **快速本地**（纯 JS 多尺度邻域扩散，零下载即时出图，适合简单背景）
- 处理前后拖动对比滑块，逐像素检验效果
- 结果可继续作为底图反复迭代去除

**添加水印**
- 文字水印：字号、颜色、字体、透明度、旋转、描边
- Logo 水印：透明度、缩放、旋转
- 满屏平铺 / 九宫格锚点定位
- 马赛克笔：直接涂抹打码

**批量处理**
- 一次导入多张图，在一张参考图上标记一次遮罩
- 遮罩按等比自动映射到每张原始尺寸图
- 逐个处理并打包为 ZIP 下载

**其他**
- 深色 / 浅色主题切换
- 项目存档（JSON）：保存底图、遮罩、结果与全部参数，随时载入继续
- 拖拽导入、剪贴板粘贴导入

## 本地运行

ES Module 与模型加载受浏览器同源策略限制，**不能直接双击 `index.html` 打开**，需要一个本地 HTTP 服务：

```bash
cd 项目目录
python3 -m http.server 8000
```

然后访问 <http://localhost:8000>

其他可选方式：

```bash
npx serve .
npx http-server -p 8000
```

## 快捷键

| 按键 | 功能 |
| --- | --- |
| `B` | 画笔工具 |
| `R` | 矩形框选 |
| `E` | 橡皮擦 |
| `M` | 马赛克笔 |
| `Ctrl / Cmd + Z` | 撤销 |
| `Ctrl / Cmd + Shift + Z` | 重做 |
| `Ctrl / Cmd + S` | 保存项目存档 |
| `0` | 视图自适应窗口 |

## AI 模型说明

首次使用「AI 高质量」引擎时，会从 HuggingFace CDN 下载约 **200MB** 的 `lama_fp32.onnx` 模型，下载时显示实时进度。下载完成后会缓存在浏览器 Cache Storage 中，**之后打开无需重复下载**。

如需释放空间或重新下载，使用右侧面板的「清除缓存」按钮。

模型信息：

- 来源：[Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX)
- 论文：Resolution-robust Large Mask Inpainting with Fourier Convolutions (WACV 2022)
- 输入固定为 512×512，本工具会自动围绕水印区域裁切、推理、羽化贴回，从而保持原图分辨率

### 如果不方便下载模型

选择「快速本地修复」引擎即可完全离线工作，适合纯色背景或面积较小的水印。

## 目录结构

```
├── index.html          页面结构
├── css/style.css       双主题样式（CSS 变量）
└── js/
    ├── app.js          主控制器与 UI 装配
    ├── core.js         状态、工具、Toast、Canvas 辅助
    ├── mask.js         画板：遮罩标记、马赛克、撤销重做
    ├── inpaint.js      AI 引擎 + 快速引擎
    ├── watermark.js    水印合成
    ├── batch.js        批量队列
    └── project.js      项目存档
```

## 部署到 GitHub Pages

本项目为纯静态站点，无任何构建步骤。

1. 推送代码到 GitHub 仓库
2. 仓库 **Settings → Pages → Source** 选择 `Deploy from a branch`
3. 分支选 `main`，目录选 `/ (root)`，保存
4. 稍等片刻即可通过 `https://<用户名>.github.io/<仓库名>/` 访问

> 注意：GitHub Pages 无法发送 COOP/COEP 响应头，因此代码已强制 ONNX Runtime 使用单线程 WASM（ `ort.env.wasm.numThreads = 1` ）。请勿移除该行，否则模型推理将无法在其他静态托管上运行。

## 浏览器要求

- Chrome / Edge 90+
- Safari 15.4+（WASM SIMD 支持）
- Firefox 89+

需要支持 WebAssembly、ES Modules 与 Cache Storage。

## 说明

请仅对拥有合法权益的图片使用本工具，尊重他人版权与署名。
