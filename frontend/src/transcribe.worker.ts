import {env, pipeline} from '@huggingface/transformers'

env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = '/models/'
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
    const transcriber = await pipeline('automatic-speech-recognition', `Xenova/whisper-${model}`, {
      device: engine === 'webgpu' ? 'webgpu' : 'wasm',
      dtype: 'q8',
      progress_callback: (progress: {status: string; file?: string; progress?: number}) => {
        self.postMessage({type: 'model', text: progress.status === 'progress'
          ? `下载模型 ${progress.file || ''} · ${Math.floor(progress.progress || 0)}%`
          : progress.status === 'ready' ? '模型就绪' : '正在加载本地转写模型…'})
      },
    })
    const length = 25 * 16000
    for (let offset = 0; offset < samples.length; offset += length) {
      const end = Math.min(samples.length, offset + length)
      const output = await transcriber(samples.slice(offset, end), {
        return_timestamps: true,
        ...(language === 'auto' ? {} : {language: {zh: 'chinese', en: 'english', ja: 'japanese'}[language] || language}),
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
  } catch (error) {self.postMessage({type: 'error', error: (error as Error).message})}
}
