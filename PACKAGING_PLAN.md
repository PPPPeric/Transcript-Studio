# LLJ Transcript Studio 跨电脑安装方案（安装包不含模型）

## 目标体验

用户下载安装包后，双击图标即可使用现有的导入、转写、波形播放、文字校对、保存和导出功能。用户不需要自行安装 Python、Node.js、npm、Homebrew 或 FFmpeg。首次使用某个转写模型时联网下载；下载完成后，该模型的转写在本机运行，断网也能继续使用。音频、视频和文字稿不上传到转写服务。

第一批发行目标为 **macOS Apple Silicon** 和 **Windows x64**，分别制作安装包。Intel Mac、Windows ARM 和 GPU 加速可在后续版本评估。

## 安装包里有什么

| 平台 | 随安装包提供 | 转写引擎 |
| --- | --- | --- |
| macOS Apple Silicon | 启动器、Python 运行环境及依赖、已构建的网页、FFmpeg/FFprobe | MLX Whisper，另带 faster-whisper 作为备选 |
| Windows x64 | 启动器、Python 运行环境及依赖、已构建的网页、FFmpeg/FFprobe | faster-whisper，先以 CPU 模式运行 |

**不打包** tiny、base、small、medium、large-v3 的任何模型文件，也不打包开发电脑上的 `.model-cache/`、`projects/`、音视频、日志、虚拟环境或 `node_modules/`。网页在构建时生成；最终用户无需安装 Node.js。MLX 是面向 Apple Silicon 的框架，因此 Windows 版不显示 MLX 引擎。两个平台的程序应分别在相应系统上构建和测试。[PyInstaller 文档](https://www.pyinstaller.org/en/stable/usage.html)说明跨系统需要分别打包；[MLX 项目](https://github.com/ml-explore/mlx)说明其 Apple Silicon 定位。

## 模型如何下载和管理

1. 模型选择区显示五档模型的用途、预计下载量和状态：**未下载 / 下载中 / 已下载**。下载量按实际引擎显示；同名档位的 MLX 与 faster-whisper 文件不是同一份，可能分别占空间。
2. 用户首次点击“下载并转写”时，先下载选定模型，再开始转写。下载进度与音频转写百分比分开显示，避免把下载等待误报为转写进度。
3. 下载支持取消、失败重试和继续使用已完整下载的模型；完成前不将不完整文件标成“已下载”。下载前检查可用磁盘空间，并给出清楚的网络或空间不足提示。
4. 设置页显示模型占用空间，并允许删除不再使用的模型。再次使用被删除的模型时重新下载。
5. 模型放在用户可写的数据目录，不放在只读安装包内。建议 macOS 使用 `~/Library/Application Support/LLJ Transcript Studio/`，Windows 使用 `%LOCALAPPDATA%\LLJ Transcript Studio\`，分别存放 `models/`、`projects/` 和 `logs/`。更新或卸载程序时不要自动删除用户项目；删除模型应由用户主动操作。

MLX Whisper 和 faster-whisper 都能从模型仓库按需获取模型；Hugging Face 缓存目录可由 `HF_HOME` 或指定缓存路径控制。模型下载需要用户电脑能访问模型源，实际发布前应测试目标地区的下载成功率并准备经核验的可配置下载来源。[MLX Whisper](https://github.com/ml-explore/mlx-examples/blob/main/whisper/README.md)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[Hugging Face 缓存说明](https://huggingface.co/docs/huggingface_hub/main/guides/manage-cache)。

## 现有项目需要改造的地方

1. **启动方式**：新增桌面启动器，启动本机服务并打开页面；退出应用时关闭服务。服务只监听 `127.0.0.1`，处理端口占用，防止重复启动。普通用户不再运行 `scripts/start.command`。
2. **读写目录**：当前 `backend/app/main.py` 默认把项目和模型缓存放在源码目录，打包后必须改为上述用户数据目录。启动器将路径传给后端；原有项目需要一次性迁移或提供“导入旧项目”入口。
3. **视频处理**：将 FFmpeg 和 FFprobe 随程序提供，后端优先调用随包版本，不再依赖系统命令。发布时确认所选 FFmpeg 构建的许可条件并随包提供所需许可信息。[FFmpeg 官方说明](https://www.ffmpeg.org/legal.html)。
4. **模型状态**：将自动下载从“转写启动”阶段拆出，增加下载状态、独立进度、错误重试、缓存查看和删除。转写进度仍只代表已处理的音频位置。
5. **平台差异**：macOS Apple Silicon 提供 MLX 和 faster-whisper；Windows 只提供 faster-whisper。按平台隐藏不支持的选项，并在干净机器上验证音频、视频及中文转写。
6. **构建与发布**：用锁定的依赖分别构建两个平台的独立目录包，再制作为 macOS `.dmg` 和 Windows 安装程序。打包前检查产物中不存在模型、项目音视频或私人日志。macOS 公开分发版还需签名与公证，以便正常通过 Gatekeeper。[Apple 分发文档](https://developer.apple.com/documentation/technologyoverviews/distribution)。

## 体积与验收

当前 Apple Silicon 开发机的磁盘实测如下，均为**未压缩的开发环境文件大小**，并非最终安装包大小：

| 部分 | 约占用 |
| --- | ---: |
| 两套引擎及其他 Python 依赖（`.venv`） | 1,343 MiB |
| Python 运行环境 | 74 MiB |
| 当前 Homebrew FFmpeg 安装目录 | 52 MiB |
| 后端代码与已构建网页 | 小于 1 MiB |
| **不含模型和用户项目的参考合计** | **约 1.44 GiB** |

虚拟环境中体积较大的目录包括 PyTorch 583 MiB、MLX 159 MiB、llvmlite 125 MiB、SciPy 98 MiB、ONNX Runtime 80 MiB、SymPy 72 MiB 和 PyAV 44 MiB。开发机另有约 3.14 GiB 的模型缓存、210 MiB 的用户项目和 69 MiB 的前端开发依赖，**这些都不进入安装包**。真正随包提供的 FFmpeg 文件及其动态库可能与 Homebrew 目录不同，最终体积需以实际构建产物测量。

优先按下列顺序精简：

1. **仅收集运行时用到的模块**，不用原样复制虚拟环境。当前 `mlx-whisper` 虽声明依赖 PyTorch，但已在 PyTorch 包和元数据均不存在的隔离环境中完成当前应用转写流程，并构建不含 PyTorch 的独立 MLX 测试程序，使用 tiny、base、large-v3 成功转写。PyTorch 在本机占约 583 MiB，正式安装包应排除它，并按 [测试记录](PYTORCH_RUNTIME_TEST.md) 补齐 MLX 所需资源。完整应用安装包和 `small`、`medium` 仍须发布前复测。
2. **Windows 只打包 faster-whisper**，不带 MLX 相关依赖。macOS 先保留 MLX 与 faster-whisper 备选；若进一步追求极小安装包，可另做 faster-whisper 专用的 Mac 轻量版，但会失去 MLX 加速。直接移除 Mac 的 faster-whisper 备选，按本机相关目录估计只节省约 0.1-0.2 GiB，且会失去故障回退。
3. **排除开发产物与用户数据**，并按实际导入裁剪无关模块。安装包压缩只减少下载体积，不等于安装后占用；应分别记录下载大小、安装大小和模型缓存大小。[PyInstaller 运行方式](https://pyinstaller.org/en/stable/operating-mode.html)。

精简后的 macOS、Windows 真实大小，必须在各平台完成第一次正式打包后重新测量，不沿用上述开发环境合计。

发布前在两台未配置开发环境的测试机上确认：安装后可直接打开；初次选择模型时能看见下载进度；下载后断网可转写；取消和重试不损坏缓存；视频能提取音轨；已有项目在升级后仍能打开；卸载不会误删用户资料。

此文档是**待实施的分发方案**。当前仓库仍是需要预装开发依赖的一键启动 MVP，尚未生成可交付其他电脑的安装包。
