# LLJ Transcript Studio

面向 macOS Apple Silicon 的本地音视频转写与校对工作台。导入音频或视频，使用 MLX Whisper 或 faster-whisper 转写，在左右并排的播放器和连续段落中对照校对，并导出 Markdown 或 SRT 字幕。项目数据保存在本机 `projects/`，不使用数据库和云端转写服务。

代码采用 [MIT 许可证](LICENSE)。公开仓库地址为 [PPPPeric/Transcript-Studio](https://github.com/PPPPeric/Transcript-Studio)。当前发布的是源码 MVP，已在 macOS Apple Silicon、Python 3.13 上验证；尚未提供 Mac 或 Windows 桌面安装包。仓库不包含模型和用户项目。所用第三方依赖及模型分别遵循各自的许可证。

## 一键启动

需要 macOS、Python 3.13、Node.js 20+、npm 和 FFmpeg。先安装 [Homebrew](https://brew.sh/)，再安装依赖：

```bash
brew install python@3.13 node ffmpeg
```

点击仓库的 Code → Download ZIP 并解压，或者使用 Git 下载：

```bash
git clone https://github.com/PPPPeric/Transcript-Studio.git
cd Transcript-Studio
```

进入项目文件夹，在 Finder 中双击 `scripts/start.command`，或在终端运行：

```bash
./scripts/start.command
```

首次运行会安装 Python 和前端依赖、构建页面，随后打开 `http://127.0.0.1:8000`。首次转写需要联网下载所选模型；模型保存在项目目录的 `.model-cache/`，下载完成后可离线使用。关闭终端或按 Ctrl-C 停止服务。

若 macOS 阻止双击脚本，可在 Finder 中右键 → 打开，或使用终端命令。首次使用建议选择 `base` 模型，平衡速度和准确度。大模型需要更多内存。

## 未来安装包的模型策略

发布给其他电脑的安装包不附带 tiny、base、small、medium 或 large-v3 模型，也不包含开发电脑上的 `.model-cache/`。用户首次使用某个模型时，需要联网下载该模型；后续使用已下载的模型时可在本机离线转写。模型应存放在用户可写的应用数据目录，而不是安装包内部，并提供下载进度、失败重试、占用空间查看和删除缓存的入口。这是后续打包版本的设计，当前 MVP 尚未提供安装包或模型管理界面。

跨电脑安装的完整实施方案见 [PACKAGING_PLAN.md](PACKAGING_PLAN.md)。

## 手动启动与备选引擎

启动脚本安装 MLX Whisper 和 faster-whisper；如果 MLX 不可用，界面会自动选择 faster-whisper。若想直接使用 CPU 备选引擎：

```bash
python3.13 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-faster.txt
cd frontend && npm ci && npm run build && cd ..
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

然后打开 `http://127.0.0.1:8000`，在转写选项中选择 `faster-whisper (CPU)`。开发前端时可运行 `cd frontend && npm run dev`，Vite 会代理 `/api` 到后端。

## 使用方式

1. 将音频或视频拖入页面任意位置，或点击右上角「导入音频或视频」选择文件。支持常见音频，以及 MP4、MOV、M4V、MKV、WebM、AVI 等常见视频容器（具体编码需 FFmpeg 能解码）。视频会先在本机提取第一条音轨，再统一转成 16 kHz 单声道 WAV，之后与音频项目使用同一套转写流程。没有音轨的视频会提示错误。原始上传文件处理后删除，项目中只保留提取出的音频；单文件上限 1 GB。
2. 展开左侧「转写设置」，选择引擎、模型和语言；选择模型时，下方会显示速度、适用录音和模型文件大小的参考说明。点击「开始转写」后，设置保持展开，已识别的句子会陆续写入 JSON 并显示在页面上，进度条按已处理的音频位置显示百分比。点击「终止转写」可停止当前任务，已完成的句子仍可编辑和导出。当前 MVP 提供 Whisper 的句/片段时间戳，不提供词级对齐。
3. 左侧播放器可播放/暂停、前后跳 5 秒、调整倍速，也可点击波形定位。「波形范围」可在整段录音、附近 5 分钟、1 分钟或 15 秒之间切换；放大后可拖动波形查看局部。右侧文字稿独立滚动，播放器、项目栏和处理记录保持原位。播放时对应时间片段显示蓝色背景并在文字稿内自动滚动到可见区域。
4. 在文字稿上方搜索词语，点击结果或使用上下按钮即可跳到对应音频；Mac 上可按 ⌘F 聚焦搜索。单击文字可定位并播放，双击可在原位修改。修改后约 0.9 秒自动保存，也可点击「保存」；按 Esc 可收起编辑框。非输入框中可按 ⌘Z 撤销、⇧⌘Z 重做，也可点击按钮。
5. 单击一句文字选中后，点击「从这里分段」；段落右上角的「合并上段」可合并段落。点击「＋ 说话人」可给整段标记说话人。手动段落边界与说话人标签会随项目保存，Markdown 和 SRT 导出也会带上说话人标签。Markdown 导出分段文字，不带时间戳；SRT 保留字幕时间轴。导出前会先保存修改。
6. 点击「历史版本」可查看最近 30 个保存版本并恢复。首次使用此功能前的旧修订不会补造；恢复前的内容也会另存为一个版本。顶部「处理记录」固定显示导入、转写、终止和失败等节点的本地时间，旧项目创建时尚未记录的节点不会补造。

每个项目位于 `projects/<项目 ID>/`，包含 `audio.wav` 和内部数据文件 `transcript.json`；历史快照保存在 `versions/`。JSON 用于保存来源类型、时间戳、文字、段落边界、说话人及修订版本，界面不提供 JSON 导出。页面仅监听本机 `127.0.0.1`。

## 已知限制

- 模型需首次下载，下载速度和模型体积受网络与内存影响。
- 断电或关闭服务会中断正在进行的转写；重启后会标记失败，已完成的句子仍保留，可重新开始。
- MLX Whisper 每处理约 30 秒音频更新一次文字和进度；faster-whisper 每识别出一个片段更新。转写中的句子暂不能编辑，终止或完成后可编辑。
- MLX 的固定分段可能在 30 秒边界附近影响断句；校对时建议听一下这些位置。
- 两个引擎都基于 Whisper。`large-v3` 提供粤语语言标记；其他地方口音可以先选择「中文」尝试，但没有讯飞听见式的方言专项识别。点击段落中某个字符时，跳转位置按所在片段的字符比例估算；蓝色追踪也以片段为单位，并非精确到字词。
- 此版可编辑文字和段落布局，但不调整时间戳，也不拆分/合并底层时间片段。说话人需手动标记，暂不自动区分说话人。
- WAV 文件可能较大，长录音的波形加载会占用内存。

## 开发与验证

`frontend/` 包含 React 页面，`backend/app/` 包含接口和转写子进程，`backend/tests/` 包含临时数据测试，`scripts/` 包含 macOS 启动脚本。直接 Python 依赖固定为本机验证过的版本；传递依赖仍由包管理器解析，尚未提供完整的平台依赖锁文件。

```bash
. .venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
PYTHONPATH=backend python -m unittest discover -s backend/tests -v
cd frontend && npm run build
```

GitHub Actions 在 Ubuntu 和 macOS 上运行后端测试，并检查前端构建。转写流程测试使用模拟引擎验证逐段保存、进度、终止和重启恢复，不下载模型；真实模型准确度与性能需要本机音频验证。

## 常见启动问题

- 缺少命令：确认已安装上述依赖，并重新打开终端。
- 8000 端口被占用：关闭此前启动的服务，再运行脚本。
- 下载模型失败：确认能访问模型源；首次下载仍需要联网。
- 依赖更新：启动脚本会根据依赖文件变化重新安装；若已有 `.venv` 使用其他 Python 版本，请先重命名备份，再运行脚本。
- ZIP 下载后的脚本无法执行：在项目目录运行 `chmod +x scripts/start.command`，然后重试。
