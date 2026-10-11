# PyTorch 是否为当前转写功能所必需：测试记录

测试日期：2026-09-29。测试环境：macOS Apple Silicon、Python 3.13.2、mlx-whisper 0.4.3、MLX 0.32.3；独立包测试使用 PyInstaller 6.22.3。

## 结论

**当前 LLJ Transcript Studio 的转写运行时不需要 PyTorch。** 在找不到 `torch` 包、其安装元数据和 `torchgen` 的隔离 Python 环境中，现有后端转写进程、应用接口和首次模型下载均完成了测试。另制作了不含任何 PyTorch 文件的 macOS 独立 MLX 转写测试程序，使用 tiny、base 和 large-v3 模型均成功转写并正常退出。

这不等于整个正式应用安装包已完成。模型转换、上游库的测试代码或未来新增功能可能使用 PyTorch；当前应用只下载预转换模型并进行推理。

## 验证过程与结果

| 检查 | 结果 |
| --- | --- |
| 隔离环境中 `find_spec('torch')` 和 PyTorch 安装元数据检查 | 均不存在 |
| 现有 `app.worker`：base 中文 30 秒以上音频，跨两个分块 | 完成，2 个时间片段，进度 100% |
| 现有 `app.worker`：base 自动识别英语；large-v3 中文与粤语选项；faster-whisper base 英语 | 4 项均完成，进度 100% |
| 应用接口：引擎可用性、音频导入、启动 MLX 转写、取得 Markdown 与 SRT | 均成功 |
| 原有后端自动化测试 | 6 项通过，含音视频导入、编辑与导出 |
| 临时空缓存首次下载 MLX tiny 模型并转写 | 下载和转写均成功 |
| PyInstaller 独立 MLX 测试程序，排除 `torch`、`torchgen` | 产物约 372 MiB，未含模型；未发现 PyTorch 文件；tiny、base、large-v3 均完成实际转写 |

测试语音由本机语音合成生成，项目的既有音视频和文字稿未改动。独立程序只是转写核心的验证包，不含完整应用的前端、FFmpeg、双引擎启动器或发布签名。

## 打包注意事项

`mlx-whisper` 的安装依赖声明仍包含 PyTorch，因此普通 `pip install mlx-whisper` 会把它装进开发环境。正式打包时应只收集当前推理功能实际使用的模块，并在产物中检查 `torch` 不存在；不能仅从开发虚拟环境里手工删除目录。MLX 的冻结包还需要收集其动态子模块、`mlx_whisper` 自带的滤波器和词表资源，并将 `mlx.metallib` 放在 `libmlx.dylib` 旁。测试中这些资源缺失会导致启动失败，补齐后运行成功。

仍需在**完整应用安装包**和其他干净 Mac 上验证启动、模型首次下载、长录音、视频导入、终止转写与升级流程。`small` 和 `medium` 权重未逐个下载运行；它们由与已测试模型相同的推理代码处理，但最终发布前仍应做模型矩阵测试。
