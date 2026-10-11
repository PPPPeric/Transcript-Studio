// Audio is decoded on the visiting computer. No File or PCM is sent over HTTP.
import {reportProgress} from './progress'

const readLocal = (file: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onprogress = event => reportProgress({kind: 'import', stage: '读取本机文件', loaded: event.loaded, total: event.total,
    percent: event.lengthComputable ? event.loaded / event.total * 100 : undefined})
  reader.onload = () => resolve(reader.result as ArrayBuffer)
  reader.onerror = () => reject(new Error('无法读取本机文件'))
  reader.onabort = () => reject(new Error('文件读取已终止'))
  reader.readAsArrayBuffer(file)
})

export async function decode(file: Blob, importing = false): Promise<Float32Array> {
  const context = new AudioContext({sampleRate: 16000})
  try {
    const data = importing ? await readLocal(file) : await file.arrayBuffer()
    if (importing) reportProgress({kind: 'import', stage: '本机解码音频', detail: '浏览器解码无法提供准确百分比，请稍候。'})
    const buffer = await context.decodeAudioData(data)
    if (importing) reportProgress({kind: 'import', stage: '转换为单声道音轨', detail: '正在本机转换采样率。'})
    const output = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000)
    const source = output.createBufferSource()
    source.buffer = buffer
    source.connect(output.destination)
    source.start()
    return (await output.startRendering()).getChannelData(0)
  } finally {await context.close()}
}

export function wav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((n, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, n)) * (n < 0 ? 32768 : 32767)), true))
  return new Blob([buffer], {type: 'audio/wav'})
}

export async function importAudio(file: File): Promise<{audio: Blob; duration: number}> {
  let samples: Float32Array
  try {samples = await decode(file, true)}
  catch {
    // Lazy load local FFmpeg/WASM only for containers Web Audio cannot decode.
    const {FFmpeg} = await import('@ffmpeg/ffmpeg')
    const ffmpeg = new FFmpeg()
    try {
      reportProgress({kind: 'import', stage: '准备视频音轨提取', detail: '正在加载本机解码组件，首次使用可能需要下载。'})
      ffmpeg.on('progress', ({progress}) => reportProgress({kind: 'import', stage: '本机提取视频音轨', percent: progress * 100}))
      await ffmpeg.load({coreURL: new URL('/runtime/ffmpeg-core.js', location.origin).href,
                         wasmURL: new URL('/runtime/ffmpeg-core.wasm', location.origin).href})
      const name = 'input.' + (file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'media')
      await ffmpeg.writeFile(name, new Uint8Array(await readLocal(file)))
      reportProgress({kind: 'import', stage: '本机提取视频音轨'})
      const result = await ffmpeg.exec(['-i', name, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'audio.wav'])
      if (result !== 0) throw new Error('文件没有可解码的音轨')
      const data = await ffmpeg.readFile('audio.wav')
      if (typeof data === 'string') throw new Error('音轨读取失败')
      samples = await decode(new Blob([new Uint8Array(data).buffer], {type: 'audio/wav'}))
    } catch (error) {
      throw new Error(`本地音频解码失败：${(error as Error).message}。可以尝试 MP3、M4A 或 WAV 文件。`)
    } finally {ffmpeg.terminate()}
  }
  reportProgress({kind: 'import', stage: '生成本机音频文件'})
  // Let the progress dialog paint before encoding the PCM buffer.
  await new Promise(resolve => setTimeout(resolve, 0))
  return {audio: wav(samples), duration: samples.length / 16000}
}
