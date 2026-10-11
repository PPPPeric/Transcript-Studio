import {importAudio, decode} from './audio'
import type {Project, Segment} from './local-types'

const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('llj-transcript-browser-v1', 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore('projects', {keyPath: 'id'})
    request.result.createObjectStore('audio')
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(new Error('无法打开本地存储，请使用普通浏览窗口并允许网站存储'))
})
async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  const db = await database
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    const request = action(tx)
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = tx.onerror = () => reject(new Error(tx.error?.name === 'QuotaExceededError'
      ? '本机网站存储空间不足，请导出备份后删除旧项目' : '本地保存失败：' + (tx.error?.message || '存储不可用')))
  })
}
const read = async (id: string): Promise<Project> => {
  const value = await transaction(['projects'], 'readonly', tx => tx.objectStore('projects').get(id))
  if (!value) throw new Error('本机项目不存在')
  return value
}
const write = (project: Project) => transaction(['projects'], 'readwrite', tx => tx.objectStore('projects').put(project))
const all = (): Promise<Project[]> => transaction(['projects'], 'readonly', tx => tx.objectStore('projects').getAll())
const lock = async <T,>(action: () => Promise<T>): Promise<T> => await navigator.locks.request('lts-storage', action)
const event = (project: Project, kind: string, label: string) => project.events.push({kind, label, at: new Date().toISOString()})
function snapshot(project: Project, label: string) {
  if (project.versions.some(v => v.revision === project.revision)) return
  project.versions = [...project.versions.slice(-29), {revision: project.revision, at: new Date().toISOString(), label,
    preview: project.segments.map(s => s.text).join('').slice(0, 90), segments: structuredClone(project.segments)}]
}
let worker: Worker | undefined
let activeId: string | undefined
let finishJob: (() => void) | undefined
let queue = Promise.resolve()
const recovery = async () => {
  if (!window.isSecureContext || !navigator.locks) throw new Error('请使用 HTTPS 地址或 localhost 打开本地工作台')
  await navigator.locks.request('lts-transcription', {ifAvailable: true}, async available => {
    if (!available) return
    await lock(async () => {
      for (const project of await all()) if (['queued', 'transcribing', 'cancelling'].includes(project.status)) {
        project.status = 'cancelled'; project.modelStatus = ''; project.runId = undefined
        event(project, 'interrupted', '页面关闭，转写已中断；已完成文字保留')
        await write(project)
      }
    })
  })
}
let initialized: Promise<void> | undefined
const initialize = () => initialized ||= recovery()

async function start(id: string, options: {model: string; language: string; engine: string}): Promise<Project> {
  if (!['tiny', 'base', 'small', 'medium', 'large-v3'].includes(options.model)) throw new Error('请选择支持的转写模型')
  if (worker) throw new Error('请先完成或终止当前转写')
  return new Promise((resolve, reject) => {
    void navigator.locks.request('lts-transcription', {ifAvailable: true}, async available => {
      if (!available) {reject(new Error('另一个窗口正在转写，请先完成或终止该任务')); return}
      const runId = crypto.randomUUID()
      let complete: Promise<void>
      try {
        const audio = await audioBlob(id)
        const samples = await decode(audio)
        const project = await lock(async () => {
          const current = await read(id)
          snapshot(current, '重新转写前')
          current.segments = []; current.status = 'queued'; current.progress = 0; current.error = null
          current.runId = runId; current.revision++; current.modelStatus = '正在加载模型…'
          event(current, 'transcribing', '在本机浏览器开始转写')
          await write(current)
          return current
        })
        activeId = id
        worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), {type: 'module'})
        complete = new Promise<void>(done => {finishJob = done})
        const update = (data: {type: string; text?: string; error?: string; progress?: number; segments?: Omit<Segment, 'id'>[]}) => {
          queue = queue.then(() => lock(async () => {
            const current = await read(id)
            if (current.runId !== runId || !['queued', 'transcribing'].includes(current.status)) return
            if (data.type === 'model') current.modelStatus = data.text || ''
            if (data.type === 'chunk') {
              current.status = 'transcribing'; current.modelStatus = ''; current.progress = data.progress || 0
              current.segments.push(...(data.segments || []).map((s, index) => ({...s, id: current.segments.length + index})))
            }
            if (data.type === 'done' || data.type === 'error') {
              current.status = data.type === 'done' ? 'done' : 'error'
              current.error = data.error || null; current.modelStatus = ''; current.runId = undefined
              if (data.type === 'done') {current.progress = 100; snapshot(current, '转写完成')}
              event(current, current.status, data.type === 'done' ? '本地转写完成' : '本地转写失败')
            }
            await write(current)
          })).catch(error => {
            console.error(error)
            window.dispatchEvent(new CustomEvent('lts-error', {detail: (error as Error).message}))
            worker?.terminate(); finishJob?.()
          }).finally(() => {if (data.type === 'done' || data.type === 'error') finishJob?.()})
        }
        worker.onmessage = ({data}) => update(data)
        worker.onerror = e => update({type: 'error', error: e.message || '浏览器转写线程失败'})
        worker.postMessage({...options, samples}, [samples.buffer])
        resolve(project)
        await complete
      } catch (error) {
        await lock(async () => {
          const current = await read(id)
          if (current.runId === runId) {
            current.status = 'error'; current.error = (error as Error).message; current.runId = undefined; current.modelStatus = ''
            event(current, 'error', '本地转写失败'); await write(current)
          }
        }).catch(() => undefined)
        reject(error)
      }
      finally {worker?.terminate(); worker = undefined; activeId = undefined; finishJob = undefined}
    }).catch(reject)
  })
}

export const audioBlob = async (id: string): Promise<Blob> => {
  const audio = await transaction(['audio'], 'readonly', tx => tx.objectStore('audio').get(id))
  if (!audio) throw new Error('本地音频不存在')
  return audio
}
export const audioUrl = async (id: string) => URL.createObjectURL(await audioBlob(id))

// This adapter preserves the editor's operations but never calls a remote API.
export async function localApi<T>(url: string, init?: RequestInit): Promise<T> {
  await initialize()
  const method = init?.method || 'GET'
  const parts = url.split('/').filter(Boolean)
  const id = parts[2]
  const action = parts[3]
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
  if (url === '/api/health') return {webgpu: !!(navigator as Navigator & {gpu?: unknown}).gpu, storage: true} as T
  if (url === '/api/projects' && method === 'GET') return (await all()).reverse().map(({id, name, status}) => ({id, name, status})) as T
  if (url === '/api/projects' && method === 'POST') {
    const file = (init?.body as FormData).get('file') as File
    if (!file || file.size > 1024 ** 3) throw new Error('请选择不超过 1 GB 的文件')
    const {audio, duration} = await importAudio(file)
    const project: Project = {id: crypto.randomUUID(), name: file.name, status: 'ready', error: null,
      revision: 0, segments: [], progress: 0, duration, events: [], versions: [],
      source_kind: file.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name) ? 'video' : 'audio'}
    event(project, 'imported', '音频已导入本机浏览器')
    await transaction(['projects', 'audio'], 'readwrite', tx => {
      tx.objectStore('audio').put(audio, project.id)
      return tx.objectStore('projects').put(project)
    })
    // Request persistent storage, but do not imply that permission is guaranteed.
    void navigator.storage.persist?.().catch(() => false)
    return project as T
  }
  if (action === 'transcribe') return await start(id, body) as T
  if (action === 'cancel') {
    if (id !== activeId) throw new Error('请在启动转写的窗口终止任务')
    worker?.terminate()
    await queue
    const project = await lock(async () => {
      const current = await read(id)
      current.status = 'cancelled'; current.runId = undefined; current.modelStatus = ''
      event(current, 'cancelled', '已终止本地转写')
      await write(current)
      return current
    })
    finishJob?.()
    return project as T
  }
  if (action === 'versions') return (await read(id)).versions.slice().reverse() as T
  if (method === 'PUT' || action === 'restore') return await lock(async () => {
    const project = await read(id)
    if (['queued', 'transcribing', 'cancelling'].includes(project.status)) throw new Error('转写时不能修改文字稿')
    if ((action === 'restore' ? body.current_revision : body.revision) !== project.revision) throw new Error('项目已在其他窗口修改，请重新打开项目')
    const previous = action === 'restore' ? project.versions.find(v => v.revision === body.revision) : undefined
    if (action === 'restore' && !previous) throw new Error('历史版本不存在')
    snapshot(project, action === 'restore' ? '恢复前版本' : '修改前版本')
    project.segments = structuredClone(previous ? previous.segments : body.segments)
    project.revision++
    if (previous) {project.status = 'done'; event(project, 'restored', `恢复到版本 ${body.revision}`)}
    snapshot(project, previous ? '恢复版本' : '校对保存')
    await write(project)
    return project
  }) as T
  if (method === 'GET' && id && !action) return await read(id) as T
  throw new Error('不支持的本地操作')
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
const stamp = (seconds: number) => {
  const ms = Math.round(Math.max(0, seconds) * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
export async function exportTranscript(id: string, format: string, paragraphs: (segments: Segment[]) => Segment[][]) {
  const project = await read(id)
  const content = format === 'srt' ? project.segments.map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.speaker ? s.speaker + '：' : ''}${s.text}`).join('\n\n') + '\n'
    : '# ' + project.name + '\n\n' + paragraphs(project.segments).map(group => (group[0].speaker ? `**${group[0].speaker}：** ` : '') + group.map((s, i) => (i && /[A-Za-z0-9.,!?;:)]$/.test(group[i - 1].text.trim()) && /^[A-Za-z0-9(]/.test(s.text.trim()) ? ' ' : '') + s.text.trim()).join('')).join('\n\n')
  download(new Blob([content], {type: 'text/plain;charset=utf-8'}), project.name.replace(/\.[^.]+$/, '') + '.' + (format === 'md' ? 'md' : 'srt'))
}
export async function backupProject(id: string) {
  const {zipSync, strToU8} = await import('fflate')
  const project = await read(id)
  const archive = zipSync({'project.json': strToU8(JSON.stringify(project)), 'audio.wav': new Uint8Array(await (await audioBlob(id)).arrayBuffer())}, {level: 0})
  download(new Blob([new Uint8Array(archive).buffer], {type: 'application/zip'}), project.name + '.lts')
}
export async function restoreBackup(file: File): Promise<Project> {
  await initialize()
  const {unzipSync, strFromU8} = await import('fflate')
  if (file.size > 1024 ** 3) throw new Error('项目备份超过 1 GB')
  let total = 0
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {filter: item => {
    if (!['project.json', 'audio.wav'].includes(item.name)) return false
    total += item.originalSize
    if (total > 1024 ** 3 || (item.name === 'project.json' && item.originalSize > 64 * 1024 ** 2)) throw new Error('项目备份解压后超过本地限制')
    return true
  }})
  if (!files['project.json'] || !files['audio.wav']) throw new Error('项目备份不完整')
  const source = JSON.parse(strFromU8(files['project.json'])) as Project
  if (!source || typeof source.name !== 'string' || !Array.isArray(source.segments) || !Array.isArray(source.versions) ||
      !source.segments.every(s => typeof s.text === 'string' && Number.isFinite(s.start) && Number.isFinite(s.end))) throw new Error('项目备份格式不正确')
  const audio = new Blob([new Uint8Array(files['audio.wav']).buffer], {type: 'audio/wav'})
  const samples = await decode(audio)
  const project: Project = {...source, id: crypto.randomUUID(), duration: samples.length / 16000,
    events: Array.isArray(source.events) ? source.events : [], status: source.segments.length ? 'done' : 'ready', runId: undefined, modelStatus: '', error: null}
  event(project, 'imported', '从本地备份导入项目')
  await transaction(['projects', 'audio'], 'readwrite', tx => {
    tx.objectStore('audio').put(audio, project.id)
    return tx.objectStore('projects').put(project)
  })
  return project
}
export async function deleteProject(id: string) {
  await lock(async () => {
    const project = await read(id)
    if (['queued', 'transcribing', 'cancelling'].includes(project.status)) throw new Error('请先终止转写')
    await transaction(['projects', 'audio'], 'readwrite', tx => {
      tx.objectStore('audio').delete(id)
      return tx.objectStore('projects').delete(id)
    })
  })
}
