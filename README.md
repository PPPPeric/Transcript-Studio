# LLJ Transcript Studio

[中文](README.md) · [English](README.en.md)

浏览器本地音视频转写与校对工作台。Mac mini 只提供网页、运行库和公开模型文件；访问电脑无需安装 Python、Node.js 或 FFmpeg。录音解码、Whisper 转写、文字校对、历史版本与导出都在访问电脑的浏览器中完成，项目不上传、不跨电脑同步。

代码采用 [MIT 许可证](LICENSE)。模型和第三方运行库遵循各自的许可证；模型来源与具体版本保存在 `.browser-models/<模型仓库>/source.json`，模型卡随资源保存。

## 模型下载与本地处理

每台电脑首次使用某个模型时，会从宿主机下载该模型，随后通常使用当前浏览器的缓存。更换模型需要下载对应文件；更换浏览器或清除缓存后可能需要重新下载。下载模型不会上传录音。

以下为当前量化模型与配套文件的实际大小，采用十进制 MB：

| 模型 | 文件大小 | 适用场景 |
| --- | ---: | --- |
| tiny | 约 45 MB | 快速预览 |
| base | 约 81 MB | 清晰录音，建议先试用 |
| small | 约 254 MB | 更准确的初稿，更占内存 |
| medium | 约 780 MB | 复杂录音，较慢且更占内存 |
| large-v3 | 约 1.83 GB | 精度优先，可选粤语，内存需求最高 |

五个模型合计约 2.99 GB。浏览器按所选模型加载；首次还需要下载 ONNX 运行库，无法原生解码的音视频另需 FFmpeg 运行库。下载大小不等于运行内存。大模型加载失败时可改用较小模型；实际内存需求高于下载大小。

## 在其他电脑上使用

1. 连接获准访问 Mac mini 的 Tailscale 网络。
2. 在新版 Chrome 或 Edge 中打开部署后提供的 HTTPS 地址。本机的入口为 `http://127.0.0.1:8001`。
3. 导入录音或视频，选择模型和语言，点击「开始转写」。首次使用一个模型时，从 Mac mini 下载公开模型并在当前浏览器缓存；录音不会发送给 Mac mini。
4. 转写时保持页面打开。完成后可以播放、搜索、校对、标记说话人、分段、查看历史版本，再导出 Markdown 或 SRT。
5. 定期点击「项目备份」，下载包含音频、文字稿和历史版本的 `.lts` 文件。用「导入音频或视频」选择 `.lts` 即可在本机恢复；导入备份会创建新项目，不覆盖现有项目。

项目使用 IndexedDB 保存在当前电脑、当前浏览器、当前网站地址下。换电脑、换浏览器、换端口或从 localhost 换到 HTTPS 地址，项目列表都会不同。请日常固定使用同一个 HTTPS 地址。清除网站数据、使用无痕窗口或浏览器回收存储可能丢失项目；浏览器会请求持久存储，但不能保证获批，项目备份是可靠的迁移和备份方式。

上传入口在这个版本中是「本地导入」：应用不发送录音或文字稿到远程 API。网页服务只支持读取资源，不加载旧版后端，也不支持上传请求。访问网页和下载模型仍会产生普通网络请求及访问日志；它们不包含录音、文字稿、项目 ID 或文件名。

## 操作方式

- 导入：支持浏览器可以解码的音频，其他音视频容器使用本地 FFmpeg WebAssembly 提取第一条音轨，统一成 16 kHz 单声道 WAV。单文件上限 1 GB；实际可处理长度取决于浏览器内存和磁盘配额。
- 转写：默认使用浏览器 CPU，可试用 GPU 加速。tiny 适合预览，base 适合清晰录音，small 通常更准确且更占内存。支持中文、英文、日文和自动识别。medium 和 large-v3 适合进一步尝试复杂录音，large-v3 可选粤语；大模型需要更多内存和处理时间。
- 播放校对：播放器支持倍速、前后跳 5 秒与波形缩放，文字随播放高亮。单击文字播放，双击编辑，修改约 0.9 秒后自动保存。支持搜索、撤销、重做、手动段落与说话人标签。
- 历史版本：保留最近 30 个版本。恢复前内容也会保存到历史记录；转写时不能修改文字稿。转写设置内容可独立滚动，较矮窗口也可访问全部选项和操作按钮。
- 终止：立即结束本窗口的转写线程，已输出并保存的片段保留。关闭页面会中断转写，重新打开后标记中断；不会在后台继续。
- 删除：删除当前浏览器里的项目与音频；删除前建议下载项目备份。

## 在 Mac mini 上部署网页

仅宿主机需要 Python 3、Node.js 20+ 和 npm；客户端不需要这些环境。安装宿主机依赖：

```bash
brew install python node
git clone https://github.com/PPPPeric/Transcript-Studio.git
cd Transcript-Studio
./scripts/install-macos.sh
```

脚本准备前端依赖、公开量化模型和浏览器运行库，构建网页，并注册用户级 LaunchAgent。当前账户登录 macOS 后自动启动，退出后自动重启。只监听 `127.0.0.1:8001`，避免与 pp-daily 的 8000 端口冲突。登录时不会自动打开浏览器。

首次准备模型需要宿主机能访问 Hugging Face。如果需要使用已有代理，可指定代理地址（仅用于下载公开模型）：

```bash
LTS_MODEL_PROXY=http://127.0.0.1:7897 ./scripts/install-macos.sh
```

准备完成后，浏览器使用本站模型文件，不需要访问外部模型网站。模型文件在 `.browser-models/`，构建时复制到 `frontend/dist/models/`；这些文件不进入 Git。

准备脚本会移除 medium 编码器中转写用不到的注意力矩阵输出，避免额外占用数 GB 浏览器内存；模型权重保持原样。

```bash
# 手动启动网页，并打开浏览器
./scripts/start.command
# 查看后台状态
launchctl print "gui/$(id -u)/local.llj-transcript-studio.server"
# 更新代码后重新构建、注册并重启
git pull --ff-only
./scripts/install-macos.sh
# 停用本项目后台服务
./scripts/uninstall-macos.sh
```

日志位于 `.runtime/logs/`。请保留项目目录；移动目录后需要重新安装。已安装后台服务时直接访问页面即可，无需再手动启动。

## 通过 Tailscale 跨网络访问

如果宿主机的标准 HTTPS 443 入口已用于其他服务（例如 pp-daily），可为本项目使用独立的 HTTPS 8443 入口：

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8001
tailscale serve status
```

访问命令输出的 `https://机器名.tailnet名.ts.net:8443` 地址。只对获准连接的 Tailscale 设备开放，无需处于同一 Wi-Fi。使用 HTTPS 是浏览器本地能力的前提。使用 Serve，不启用 Funnel 或路由器公网端口转发。取消这个入口可运行：

```bash
tailscale serve --https=8443 off
```

## 旧版 Mac mini 项目

旧版 `projects/` 数据与 `.model-cache/` 均保留，但浏览器版不会读取或远程提供这些私有文件。要在某个浏览器继续旧项目，在 Mac mini 本地生成备份：

```bash
python3 scripts/export-legacy-projects.py
```

生成的 `.lts` 位于 `.runtime/legacy-backups/`，可在选定的电脑上手动导入。该目录不会通过网页提供。`backend/` 保留旧版 Python 实现供参考，默认启动脚本已改为只读网页服务。

## 开发与验证

```bash
cd frontend
npm ci
npm run build
# 首次准备 Chromium 测试浏览器
npx playwright install chromium
npm run test:browser
```

构建包含 TypeScript 检查，复制 ONNX 和 FFmpeg 的本地运行库；没有模型时会提示，部署脚本会先准备模型。前端开发 `npm run dev` 的 `/models` 和 `/runtime` 代理到本机 8001 静态服务。

自动化浏览器测试覆盖刷新后恢复、修改与历史版本、Markdown/SRT 导出、备份恢复、不同浏览器隔离、没有上传与 `/api/` 请求、网页服务拒绝上传和私有文件访问。设定 `LTS_TEST_AUDIO=/绝对路径/合成测试语音.wav` 可另跑真实 Whisper 转写与终止测试；需要先准备模型。设定 `LTS_TEST_MODEL=medium` 或 `LTS_TEST_MODEL=large-v3` 可指定实际转写测试模型。设定 `LTS_TEST_CHROME` 可使用已有 Chrome 可执行文件。实际浏览器验证也覆盖了 MKV 音轨提取。旧版后端测试仍在 GitHub Actions 中保留。

## 已知限制

- 浏览器版性能取决于访问电脑。CPU 转写通常比原 Mac mini 的 MLX 引擎慢，GPU 模式处于试验阶段，兼容性取决于浏览器和显卡。
- 音视频解码、波形、模型及备份都占用本机内存；大文件和长录音可能超出浏览器能力。建议先用短录音、tiny 或 base 试用。
- 模型按 25 秒音频块输出带时间戳的片段，块边界可能影响断句；不提供精确词级对齐。模型准确率与地方口音需要人工校对。
- 首次打开网页或首次使用未缓存的模型时需要连接 Mac mini。当前未提供离线安装/PWA；不要把模型缓存理解为整站离线可用。
- 浏览器之间不会自动同步项目。需要通过 `.lts` 手动迁移。
- 音视频解码支持取决于浏览器与 FFmpeg WASM 包含的编解码器；失败时尝试转成 MP3、M4A 或 WAV。

此前的桌面安装包计划与 Python 运行时验证记录仍保留在 `PACKAGING_PLAN.md` 与 `PYTORCH_RUNTIME_TEST.md`，它们描述旧版方案，不代表当前浏览器版。
