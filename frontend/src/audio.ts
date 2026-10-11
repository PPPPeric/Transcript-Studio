// Audio is decoded on the visiting computer. No File or PCM is sent over HTTP.
export async function decode(file: Blob): Promise<Float32Array> {
  const context = new AudioContext({sampleRate: 16000})
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
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
  try {samples = await decode(file)}
  catch {
    // Lazy load local FFmpeg/WASM only for containers Web Audio cannot decode.
    const {FFmpeg} = await import('@ffmpeg/ffmpeg')
    const ffmpeg = new FFmpeg()
    try {
      await ffmpeg.load({coreURL: new URL('/runtime/ffmpeg-core.js', location.origin).href,
                         wasmURL: new URL('/runtime/ffmpeg-core.wasm', location.origin).href})
      const name = 'input.' + (file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'media')
      await ffmpeg.writeFile(name, new Uint8Array(await file.arrayBuffer()))
      const result = await ffmpeg.exec(['-i', name, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'audio.wav'])
      if (result !== 0) throw new Error('文件没有可解码的音轨')
      const data = await ffmpeg.readFile('audio.wav')
      if (typeof data === 'string') throw new Error('音轨读取失败')
      samples = await decode(new Blob([new Uint8Array(data).buffer], {type: 'audio/wav'}))
    } catch (error) {
      throw new Error(`本地音频解码失败：${(error as Error).message}。可以尝试 MP3、M4A 或 WAV 文件。`)
    } finally {ffmpeg.terminate()}
  }
  return {audio: wav(samples), duration: samples.length / 16000}
}
