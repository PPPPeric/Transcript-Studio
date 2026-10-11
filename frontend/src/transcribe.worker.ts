import {env, pipeline} from '@huggingface/transformers'

env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = '/models/'
const networkFiles = new Set<string>()
// Only download fixed same-origin model/runtime assets, with retries for proxies.
env.fetch = async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(input, self.location.origin)
  if (url.origin !== self.location.origin || !/^\/(models|runtime)\//.test(url.pathname) ||
      init.body || !['GET', 'HEAD'].includes(init.method || 'GET')) throw new Error('模型加载只能读取本站资源')
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {...init, credentials: 'omit'})
      if ([502, 503, 504].includes(response.status)) {
        await response.body?.cancel()
        throw new Error(`模型下载暂时不可用 (${response.status})`)
      }
      if (response.ok && (init.method || 'GET') === 'GET') networkFiles.add(url.pathname)
      return response
    } catch (error) {
      if (attempt >= 3) throw error
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
}
env.backends.onnx.wasm!.wasmPaths = '/runtime/'
env.backends.onnx.wasm!.numThreads = 1

self.onmessage = async ({data}: MessageEvent<{samples: Float32Array; model: string; language: string; engine: string}>) => {
  try {
    const {samples, model, language, engine} = data
    const downloads = new Map<string, {name: string; loaded: number; total?: number}>()
    let lastProgress = 0
    const transcriber = await pipeline('automatic-speech-recognition', model === 'large-v3' ? 'onnx-community/whisper-large-v3-ONNX' : `Xenova/whisper-${model}`, {
      device: engine === 'webgpu' ? 'webgpu' : 'wasm',
      dtype: 'q8',
      progress_callback: (progress: {status: string; file?: string; progress?: number; loaded?: number; total?: number}) => {
        if (progress.status === 'progress') {
          const downloading = [...networkFiles].some(path => path.endsWith('/' + progress.file))
          if (!downloading) {
            if (Date.now() - lastProgress < 150 && (progress.progress || 0) < 100) return
            lastProgress = Date.now()
            self.postMessage({type: 'model', text: '正在读取本机模型缓存…', download: {kind: 'model', stage: '读取本机模型缓存',
              detail: progress.file, percent: progress.progress, loaded: progress.loaded, total: progress.total}})
            return
          }
          if (progress.file?.endsWith('.onnx')) downloads.set(progress.file, {name: progress.file, loaded: progress.loaded || 0, total: progress.total})
          if (Date.now() - lastProgress < 150 && (progress.progress || 0) < 100) return
          lastProgress = Date.now()
          const files = [...downloads.values()]
          const total = files.reduce((sum, file) => sum + (file.total || 0), 0)
          const loaded = files.reduce((sum, file) => sum + file.loaded, 0)
          const aggregate = files.length === 2 && files.every(file => !!file.total)
          self.postMessage({type: 'model', text: `下载模型 ${progress.file || ''} · ${Math.floor(progress.progress || 0)}%`,
            download: {kind: 'model', stage: aggregate ? '下载转写模型' : '下载模型文件',
              detail: aggregate ? '编码器与解码器下载进度' : progress.file,
              percent: aggregate ? loaded / total * 100 : progress.progress,
              loaded: aggregate ? loaded : progress.loaded, total: aggregate ? total : progress.total, files}})
        } else if (!downloads.size) {
          self.postMessage({type: 'model', text: '正在读取缓存或加载转写模型…'})
        } else if (progress.status === 'done' && progress.file) {
          const file = downloads.get(progress.file)
          if (file?.total) file.loaded = file.total
          if ([...downloads.values()].every(file => file.total && file.loaded >= file.total)) self.postMessage({type: 'model', text: '下载完成，正在加载模型到本机内存…'})
        }
      },
    })
    self.postMessage({type: 'model-ready'})
    const length = 25 * 16000
    for (let offset = 0; offset < samples.length; offset += length) {
      const end = Math.min(samples.length, offset + length)
      const output = await transcriber(samples.slice(offset, end), {
        return_timestamps: true,
        ...(language === 'auto' ? {} : {language: {zh: 'chinese', en: 'english', ja: 'japanese', yue: 'cantonese'}[language] || language}),
        task: 'transcribe',
      })
      const result = (Array.isArray(output) ? output[0] : output) as {text: string; chunks?: {text: string; timestamp: [number | null, number | null]}[]}
      const chunks = result.chunks || [{text: result.text, timestamp: [0, (end - offset) / 16000]}]
      self.postMessage({type: 'chunk', progress: end / samples.length * 100,
        segments: chunks.filter(chunk => chunk.text.trim()).map(chunk => ({
          start: Math.max(offset / 16000, offset / 16000 + (chunk.timestamp[0] || 0)),
          end: Math.min(end / 16000, offset / 16000 + (chunk.timestamp[1] ?? (end - offset) / 16000)),
          text: chunk.text.trim(),
        }))})
    }
    await transcriber.dispose()
    self.postMessage({type: 'done'})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    self.postMessage({type: 'error', error: /bad_alloc|out of memory|memory access out of bounds/i.test(message)
      ? '本机浏览器可用内存不足，请关闭其他标签页、尝试 GPU 引擎或改用较小模型。' : message})
  }
}
