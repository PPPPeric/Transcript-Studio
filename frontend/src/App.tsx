import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import WaveSurfer from 'wavesurfer.js'
import ProgressDialog from './ProgressDialog'
import {reportProgress, finishProgress, type TaskProgress} from './progress'

import {localApi as api, audioUrl, exportTranscript, backupProject, restoreBackup, deleteProject} from './local-client'
import type {Segment, Project, Version} from './local-types'
type Summary = Pick<Project, 'id' | 'name' | 'status'>
type Health = {webgpu: boolean; storage: boolean}

const json = (data: unknown) => ({headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)})
const clock = (value: number) => {
  const n = Math.floor(value || 0)
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}
const eventTime = (value: string) => new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false})
const statusText = (status: string) => ({ready: '待转写', queued: '准备转写', transcribing: '转写中', cancelling: '正在终止', cancelled: '已终止', done: '已转写', error: '转写失败'}[status] || status)
const modelChoices = [
  {id: 'tiny', label: 'tiny · 快速预览', size: '约 45 MB', tradeoff: '最快 · 校对较多', description: '适合先了解内容大意；细节、专有词通常需要更多人工校对。'},
  {id: 'base', label: 'base · 清晰录音', size: '约 81 MB', tradeoff: '较快 · 轻量', description: '适合清晰录音的快速初稿，仍建议逐段检查。'},
  {id: 'small', label: 'small · 日常推荐', size: '约 254 MB', tradeoff: '速度与准确率较均衡', description: '建议日常使用；通常比小模型省些校对时间。'},
  {id: 'medium', label: 'medium · 复杂录音', size: '约 780 MB', tradeoff: '较慢 · 内存占用较高', description: '适合较复杂的录音；首次下载较大，建议使用内存充足的电脑。'},
  {id: 'large-v3', label: 'large-v3 · 精度优先', size: '约 1.83 GB', tradeoff: '最慢 · 内存占用最高', description: '可尝试复杂录音和粤语；浏览器可能因内存不足加载失败，建议 GPU 加速或改用较小模型。'},
] as const

function paragraphs(segments: Segment[]): Segment[][] {
  const groups: Segment[][] = []
  let current: Segment[] = []
  for (const segment of [...segments].sort((a, b) => a.start - b.start || a.id - b.id)) {
    const previous = current.at(-1)
    const gap = previous ? segment.start - previous.end : 0
    const autoBreak = gap > 3.5 || current.length >= 45 || (current.length >= 25 && segment.start - current[0].start > 90)
    if (current.length && (segment.paragraphStart === true || (segment.paragraphStart !== false && autoBreak))) {
      groups.push(current)
      current = []
    }
    current.push(segment)
  }
  if (current.length) groups.push(current)
  return groups
}
const prefix = (previous: Segment | undefined, current: Segment) => {
  if (!previous) return ''
  return /[A-Za-z0-9.,!?;:)]$/.test(previous.text.trim()) && /^[A-Za-z0-9(]/.test(current.text.trim()) ? ' ' : ''
}
function highlightText(value: string, query: string): ReactNode {
  if (!query.trim()) return value
  const lower = value.toLocaleLowerCase()
  const needle = query.trim().toLocaleLowerCase()
  const parts: ReactNode[] = []
  let start = 0
  let found = lower.indexOf(needle)
  while (found >= 0) {
    parts.push(value.slice(start, found), <mark key={found}>{value.slice(found, found + needle.length)}</mark>)
    start = found + needle.length
    found = lower.indexOf(needle, start)
  }
  parts.push(value.slice(start))
  return parts
}

export default function App() {
  const [list, setList] = useState<Summary[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [engine, setEngine] = useState<'webgpu' | 'wasm'>('wasm')
  const [model, setModel] = useState('base')
  const [language, setLanguage] = useState('zh')
  const [busy, setBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<TaskProgress | null>(null)
  const [modelProgress, setModelProgress] = useState<TaskProgress | null>(null)
  const [hiddenProgress, setHiddenProgress] = useState<{import: boolean; model: boolean}>({import: false, model: false})
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [drag, setDrag] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null)
  const [editingSegmentId, setEditingSegmentId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<Version[]>([])
  const [versionsBusy, setVersionsBusy] = useState(false)
  const [, setHistorySerial] = useState(0)
  const [speakerEditingId, setSpeakerEditingId] = useState<number | null>(null)
  const [speakerDraft, setSpeakerDraft] = useState('')
  const [zoomWindow, setZoomWindow] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const waveRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const activeRef = useRef<HTMLSpanElement | null>(null)
  const transcriptRef = useRef<HTMLElement | null>(null)
  const projectRef = useRef<Project | null>(null)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const pendingJump = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const zoomWindowRef = useRef(0)
  const undoStack = useRef<Segment[][]>([])
  const redoStack = useRef<Segment[][]>([])
  const editSession = useRef<number | null>(null)
  const projectId = project?.id

  const update = (next: Project) => {projectRef.current = next; setProject(next)}
  const resetLocalHistory = () => {undoStack.current = []; redoStack.current = []; editSession.current = null; setHistorySerial(value => value + 1)}
  const remember = () => {
    if (!projectRef.current) return
    undoStack.current = [...undoStack.current.slice(-29), projectRef.current.segments]
    redoStack.current = []
    setHistorySerial(value => value + 1)
  }
  const changeSegments = (segments: Segment[], record = true) => {
    if (!projectRef.current) return
    if (record) remember()
    update({...projectRef.current, segments})
    generation.current++; dirtyRef.current = true; setDirty(true); setMessage('有未保存的修改')
  }
  const refreshList = () => api<Summary[]>('/api/projects').then(setList).catch(error => setMessage(error.message))
  const loadVersions = async (id: string) => {
    try {setVersions(await api<Version[]>(`/api/projects/${id}/versions`))}
    catch (error) {setMessage((error as Error).message)}
  }

  useEffect(() => {
    const onError = (event: Event) => setMessage((event as CustomEvent<string>).detail)
    window.addEventListener('lts-error', onError)
    const onProgress = (event: Event) => {
      const data = (event as CustomEvent<TaskProgress & {finished?: boolean}>).detail
      if (data.start) setHiddenProgress(previous => ({...previous, [data.kind]: false}))
      if (data.kind === 'import') setImportProgress(data.finished ? null : data)
      else setModelProgress(data.finished ? null : data)
    }
    window.addEventListener('lts-progress', onProgress)
    refreshList()
    api<Health>('/api/health').then(value => {setHealth(value); setEngine('wasm')}).catch(error => setMessage(error.message))
    return () => {window.removeEventListener('lts-error', onError); window.removeEventListener('lts-progress', onProgress)}
  }, [])

  const openProject = async (id: string) => {
    if (dirtyRef.current && !confirm('有未保存的修改。确定切换项目？')) return
    try {
      const next = await api<Project>(`/api/projects/${id}`)
      dirtyRef.current = false; setDirty(false); setSelectedSegmentId(null); setEditingSegmentId(null); setSettingsOpen(next.status !== 'done'); setMessage(''); setSearch(''); setSearchOpen(false); setVersionsOpen(false); setZoomWindow(0); zoomWindowRef.current = 0; resetLocalHistory(); update(next)
    } catch (error) {setMessage((error as Error).message)}
  }

  useEffect(() => {
    if (!projectId || !waveRef.current) return
    const ws = WaveSurfer.create({container: waveRef.current,
      waveColor: '#a6b7c8', progressColor: '#2563dc', cursorColor: '#173b70', height: 100,
      barWidth: 2, barGap: 1, barRadius: 2})
    wsRef.current = ws
    let disposed = false
    let blobUrl = ''
    audioUrl(projectId).then(url => {if (disposed) {URL.revokeObjectURL(url); return}; blobUrl = url; return ws.load(url)}).catch(error => {if (!disposed) setMessage(error.message)})
    let lastUiTime = -1
    ws.on('ready', () => {
      setDuration(ws.getDuration()); ws.setPlaybackRate(speed)
      const windowSeconds = zoomWindowRef.current
      if (windowSeconds) ws.zoom(ws.getDuration() <= windowSeconds ? 0 : (waveRef.current?.clientWidth || 240) / windowSeconds)
    })
    ws.on('timeupdate', value => {
      if (Math.abs(value - lastUiTime) >= 0.25 || value === 0) {lastUiTime = value; setTime(value)}
    })
    ws.on('play', () => setPlaying(true))
    ws.on('pause', () => setPlaying(false))
    ws.on('error', error => setMessage(`音频加载失败：${error.message}`))
    return () => {disposed = true; if (blobUrl) URL.revokeObjectURL(blobUrl); ws.destroy(); wsRef.current = null; setPlaying(false); setTime(0); setDuration(0)}
  }, [projectId])

  useEffect(() => {
    if (!projectId || !project || !['queued', 'transcribing', 'cancelling'].includes(project.status)) return
    const timer = setInterval(async () => {
      try {
        const next = await api<Project>(`/api/projects/${projectId}`)
        if (!dirtyRef.current) update(next)
        if (['done', 'error', 'cancelled'].includes(next.status)) refreshList()
      } catch (error) {setMessage((error as Error).message)}
    }, 800)
    return () => clearInterval(timer)
  }, [projectId, project?.status])

  const save = async () => {
    if (!dirtyRef.current || savingRef.current || !projectRef.current) return
    savingRef.current = true; setSaving(true)
    const snapshot = projectRef.current
    const version = generation.current
    try {
      const next = await api<Project>(`/api/projects/${snapshot.id}`, {method: 'PUT', ...json({revision: snapshot.revision, segments: snapshot.segments})})
      if (projectRef.current?.id === next.id) {
        update({...next, segments: generation.current === version ? next.segments : projectRef.current.segments})
        if (generation.current === version) {dirtyRef.current = false; setDirty(false); setMessage('已保存')}
        if (versionsOpen) loadVersions(next.id)
      }
    } catch (error) {setMessage(`保存失败：${(error as Error).message}`)}
    finally {
      savingRef.current = false; setSaving(false)
      if (dirtyRef.current && generation.current !== version) setTimeout(() => saveRef.current(), 0)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => saveRef.current(), 900)
    return () => clearTimeout(timer)
  }, [dirty, project?.segments])

  const edit = (id: number, value: string) => {
    if (!projectRef.current) return
    if (editSession.current !== id) {remember(); editSession.current = id}
    changeSegments(projectRef.current.segments.map(segment => segment.id === id ? {...segment, text: value} : segment), false)
  }

  const undo = () => {
    if (!projectRef.current || !undoStack.current.length || transcribing) return
    const previous = undoStack.current.pop()!
    redoStack.current.push(projectRef.current.segments)
    editSession.current = null; setEditingSegmentId(null)
    changeSegments(previous, false); setHistorySerial(value => value + 1)
  }
  const redo = () => {
    if (!projectRef.current || !redoStack.current.length || transcribing) return
    const next = redoStack.current.pop()!
    undoStack.current.push(projectRef.current.segments)
    editSession.current = null; setEditingSegmentId(null)
    changeSegments(next, false); setHistorySerial(value => value + 1)
  }

  const upload = async (file?: File) => {
    if (!file || busy) return
    if (dirtyRef.current && !confirm('有未保存的修改。确定导入新项目？')) return
    const video = file.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name)
    setBusy(true); setMessage(video ? '正在导入视频并提取音轨…' : '正在导入和处理音频…')
    reportProgress({kind: 'import', stage: file.name.endsWith('.lts') ? '读取本机项目备份' : '读取本机文件', detail: file.name, start: true})
    try {
      const data = new FormData(); data.append('file', file)
      const next = file.name.endsWith('.lts') ? await restoreBackup(file) : await api<Project>('/api/projects', {method: 'POST', body: data})
      await refreshList(); generation.current++; dirtyRef.current = false; setDirty(false); setSelectedSegmentId(null); setEditingSegmentId(null); setSettingsOpen(true); setSearch(''); setVersionsOpen(false); setZoomWindow(0); zoomWindowRef.current = 0; resetLocalHistory(); update(next); setMessage(next.source_kind === 'video' ? '视频音轨提取完成，可以开始转写' : '导入完成，可以开始转写')
    } catch (error) {setMessage((error as Error).message)}
    finally {finishProgress('import'); setBusy(false); if (fileRef.current) fileRef.current.value = ''}
  }

  const transcribe = async () => {
    if (!project) return
    if (project.segments.length && !confirm('重新转写会替换当前文字稿，确定继续？')) return
    setBusy(true); setMessage('正在启动转写…')
    reportProgress({kind: 'model', stage: '准备本机转写', start: true})
    try {
      const next = await api<Project>(`/api/projects/${project.id}/transcribe`, {method: 'POST', ...json({engine, model, language})})
      setSelectedSegmentId(null); setEditingSegmentId(null); setSettingsOpen(true); setVersionsOpen(false); resetLocalHistory(); update(next); refreshList(); setMessage('转写已开始，文字会逐段显示。')
    } catch (error) {finishProgress('model'); setMessage((error as Error).message)}
    finally {setBusy(false)}
  }

  const cancel = async () => {
    if (!project) return
    setBusy(true); setMessage('正在终止转写…')
    try {
      const next = await api<Project>(`/api/projects/${project.id}/cancel`, {method: 'POST'})
      update(next); refreshList(); setMessage('转写已终止，已完成的文字稿已保留。')
    } catch (error) {setMessage((error as Error).message)}
    finally {setBusy(false)}
  }

  const seek = (value: number) => wsRef.current?.setTime(Math.max(0, Math.min(value, duration)))
  const zoomTo = (windowSeconds: number) => {
    setZoomWindow(windowSeconds)
    zoomWindowRef.current = windowSeconds
    const ws = wsRef.current
    if (!ws) return
    const width = waveRef.current?.clientWidth || 240
    ws.zoom(!windowSeconds || ws.getDuration() <= windowSeconds ? 0 : width / windowSeconds)
    if (windowSeconds) ws.setScrollTime(Math.max(0, ws.getCurrentTime() - windowSeconds / 2))
  }
  const jumpToSegment = (segment: Segment, fraction = 0) => {
    setSelectedSegmentId(segment.id)
    seek(segment.start + (segment.end - segment.start) * fraction)
    wsRef.current?.play().catch(error => setMessage(`播放失败：${error.message}`))
  }
  const beginEdit = (segment: Segment) => {
    if (pendingJump.current) clearTimeout(pendingJump.current)
    pendingJump.current = null
    if (transcribing) return
    wsRef.current?.pause()
    setSelectedSegmentId(segment.id)
    editSession.current = null
    setEditingSegmentId(segment.id)
  }
  const clickSegment = (segment: Segment, event: MouseEvent<HTMLSpanElement>) => {
    if (event.detail > 1) {beginEdit(segment); return}
    if (window.getSelection()?.toString()) return
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY)
    const before = document.createRange()
    if (range && event.currentTarget.contains(range.startContainer)) {before.selectNodeContents(event.currentTarget); before.setEnd(range.startContainer, range.startOffset)}
    const fraction = range && event.currentTarget.contains(range.startContainer)
      ? Math.min(1, before.toString().length / Math.max(1, event.currentTarget.textContent?.length || 1)) : 0
    if (pendingJump.current) clearTimeout(pendingJump.current)
    pendingJump.current = setTimeout(() => {
      pendingJump.current = null
      jumpToSegment(segment, fraction)
    }, 260)
  }
  useEffect(() => () => {if (pendingJump.current) clearTimeout(pendingJump.current)}, [])
  const exportFile = async (format: string) => {
    try {
    if (!project) return
    if (savingRef.current) while (savingRef.current) await new Promise(resolve => setTimeout(resolve, 100))
    if (dirtyRef.current) {await saveRef.current(); if (dirtyRef.current) return}
    await exportTranscript(project.id, format, paragraphs)
    } catch (error) {setMessage((error as Error).message)}
  }
  const restoreVersion = async (revision: number) => {
    if (!projectRef.current || !confirm(`恢复版本 ${revision} 的文字稿？当前内容会先保存到历史记录。`)) return
    setVersionsBusy(true)
    try {
      while (savingRef.current) await new Promise(resolve => setTimeout(resolve, 100))
      if (dirtyRef.current) {await saveRef.current(); if (dirtyRef.current) return}
      const current = projectRef.current!
      const next = await api<Project>(`/api/projects/${current.id}/restore`, {method: 'POST', ...json({revision, current_revision: current.revision})})
      resetLocalHistory(); generation.current++; dirtyRef.current = false; setDirty(false); setEditingSegmentId(null); update(next)
      await loadVersions(next.id); setVersionsOpen(false); setMessage(`已恢复版本 ${revision}，恢复前内容也保存在历史记录中`)
    } catch (error) {setMessage(`恢复失败：${(error as Error).message}`)}
    finally {setVersionsBusy(false)}
  }
  const status = project?.status
  const transcribing = status === 'queued' || status === 'transcribing' || status === 'cancelling'
  useEffect(() => {if (status === 'done') setSettingsOpen(false)}, [status])
  useEffect(() => {
    if (!transcribing && !dirty) return
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = ''}
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [transcribing, dirty])
  const percent = Math.max(0, Math.min(100, Math.floor(project?.progress ?? (status === 'done' ? 100 : 0))))
  const active = project?.segments.reduce<Segment | undefined>((best, segment) => {
    if (time < segment.start || time >= segment.end) return best
    return !best || segment.start > best.start ? segment : best
  }, undefined)?.id
  const groups = useMemo(() => paragraphs(project?.segments || []), [project?.segments])
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? (project?.segments || []).filter(segment => segment.text.toLocaleLowerCase().includes(query)) : []
  }, [project?.segments, search])
  const selectedGroupIndex = groups.findIndex(group => group.some(segment => segment.id === selectedSegmentId))
  const selectedGroup = groups[selectedGroupIndex]
  const selectedSegment = selectedGroup?.find(segment => segment.id === selectedSegmentId)
  const scrollToSegment = (id: number) => {
    const container = transcriptRef.current
    const target = container?.querySelector(`[data-segment-id="${id}"]`)
    if (!container || !target) return
    const viewport = container.getBoundingClientRect()
    const segment = target.getBoundingClientRect()
    const heading = container.querySelector('.transcript-head')?.getBoundingClientRect().height ?? 0
    if (segment.top < viewport.top + heading + 12) container.scrollBy({top: segment.top - viewport.top - heading - 20, behavior: 'smooth'})
    else if (segment.bottom > viewport.bottom - 12) container.scrollBy({top: segment.bottom - viewport.bottom + 20, behavior: 'smooth'})
  }
  const jumpToMatch = (index: number) => {
    if (!matches.length) return
    const nextIndex = (index + matches.length) % matches.length
    setSearchIndex(nextIndex); setSearchOpen(false)
    jumpToSegment(matches[nextIndex]); scrollToSegment(matches[nextIndex].id)
  }
  const splitAtSelected = () => {
    if (!projectRef.current || !selectedSegment || selectedGroup[0].id === selectedSegment.id || transcribing) return
    editSession.current = null
    changeSegments(projectRef.current.segments.map(segment => segment.id === selectedSegment.id ? {...segment, paragraphStart: true} : segment))
  }
  const mergeWithPrevious = (group: Segment[], index: number) => {
    if (!projectRef.current || index < 1 || transcribing) return
    editSession.current = null
    const ids = new Set(group.map(segment => segment.id))
    const speaker = groups[index - 1][0].speaker
    changeSegments(projectRef.current.segments.map(segment => ids.has(segment.id)
      ? {...segment, paragraphStart: false, speaker} : segment))
  }
  const setGroupSpeaker = (group: Segment[], value: string) => {
    setSpeakerEditingId(null)
    const speaker = value.trim().slice(0, 60) || undefined
    if (!projectRef.current || group.every(segment => segment.speaker === speaker)) return
    editSession.current = null
    const ids = new Set(group.map(segment => segment.id))
    changeSegments(projectRef.current.segments.map(segment => ids.has(segment.id) ? {...segment, speaker} : segment))
  }
  useEffect(() => {
    if (!projectId) return
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement
      const editing = target.matches('input, textarea, [contenteditable="true"]')
      if (event.key.toLocaleLowerCase() === 'f') {event.preventDefault(); setSearchOpen(true); searchRef.current?.focus()}
      else if (event.key.toLocaleLowerCase() === 'z' && !editing) {event.preventDefault(); if (event.shiftKey) redo(); else undo()}
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [projectId, project?.segments, status])
  useEffect(() => {
    const container = transcriptRef.current
    const target = activeRef.current
    if (!playing || active === undefined || !container || !target) return
    const viewport = container.getBoundingClientRect()
    const segment = target.getBoundingClientRect()
    const heading = container.querySelector('.transcript-head')?.getBoundingClientRect().height ?? 0
    if (segment.top < viewport.top + heading + 12) container.scrollBy({top: segment.top - viewport.top - heading - 20, behavior: 'smooth'})
    else if (segment.bottom > viewport.bottom - 12) container.scrollBy({top: segment.bottom - viewport.bottom + 20, behavior: 'smooth'})
  }, [active, playing])

  const selectedModel = modelChoices.find(choice => choice.id === model) ?? modelChoices[1]

  return <div className={`app ${project ? 'project-open' : ''}`} onDragOver={event => {if (event.dataTransfer.types.includes('Files')) {event.preventDefault(); setDrag(true)}}} onDragLeave={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrag(false)}} onDrop={event => {event.preventDefault(); setDrag(false); upload(event.dataTransfer.files[0])}}>
    <header className="app-header"><div className="brand"><span className="brand-mark">LLJ</span><div><h1>Transcript Studio</h1><p>浏览器本地转写 · 录音不会上传</p></div></div><button className="import-button" onClick={() => fileRef.current?.click()} disabled={busy}>＋ 导入音频或视频</button></header>
    <div className="layout">
      <aside className={`sidebar ${project ? 'has-project' : ''}`}>
        <div className="panel-heading"><h2>录音项目</h2><span>{list.length}</span></div>
        <input ref={fileRef} type="file" accept=".lts,audio/*,video/*,.mp3,.m4a,.wav,.aac,.flac,.ogg,.opus,.mp4,.mov,.m4v,.mkv,.webm,.avi" hidden onChange={event => upload(event.target.files?.[0])}/>
        {!project && <div className="drop" onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={event => {if (event.key === 'Enter') fileRef.current?.click()}}>将音频或视频拖到这里<br/><small>或选择文件 / .lts 项目备份 · 上限 1 GB</small></div>}
        <div className="project-list">{list.map(item => <button key={item.id} title={item.name} className={projectId === item.id ? 'selected' : ''} onClick={() => openProject(item.id)}><strong>{item.name}</strong><small>{statusText(item.status)}</small></button>)}</div>
        <details className="requirements"><summary><span className={`health-dot ${health?.storage ? 'ready' : ''}`}/>本机浏览器状态</summary><div><small>本地存储：{health?.storage ? '就绪' : '不可用'}</small><small>WebGPU：{health?.webgpu ? '可尝试 GPU 加速' : '不可用，使用 CPU'}</small><small>录音、文字稿和历史版本仅保存在当前浏览器，不会同步到其他电脑。首次转写需要下载模型。</small><small>建议使用新版 Chrome / Edge。清除网站数据会删除项目，请定期导出项目备份。</small></div></details>
      </aside>
      <main>
        {!project ? <div className="empty"><div className="empty-icon">♪</div><h2>从一段音频或视频开始</h2><p>导入 MP3、M4A、WAV 或 MP4、MOV 等文件。文件在当前电脑解码并转写，不会上传到 Mac mini。</p></div> : <>
          <section className="project-toolbar"><div className="project-identity"><span className="eyebrow">当前{project.source_kind === 'video' ? '视频' : '录音'}</span><div className="project-name"><h2 title={project.name}>{project.name}</h2><span className={`status-chip ${status}`}>{statusText(project.status)}</span></div><small>{clock(duration || project.duration || 0)} · {project.segments.length} 个时间片段{project.source_kind === 'video' ? ' · 已提取音轨' : ''}</small></div><div className="exports"><span>导出文字稿</span>{([{format: 'md', label: 'Markdown'}, {format: 'srt', label: 'SRT 字幕'}] as const).map(({format, label}) => <button key={format} onClick={() => exportFile(format)} title={`导出 ${label}`}>{label}</button>)}<button disabled={transcribing || dirty || saving} onClick={async () => {try {await backupProject(project.id); setMessage('项目备份已下载，包含音频和历史版本')} catch (error) {setMessage((error as Error).message)}}}>项目备份</button><button disabled={transcribing || dirty || saving} onClick={async () => {if (!confirm('删除当前浏览器中的这个项目？请先下载项目备份。')) return; try {await deleteProject(project.id); projectRef.current = null; setProject(null); await refreshList()} catch (error) {setMessage((error as Error).message)}}}>删除</button></div></section>
          <section className="events-card" aria-label="处理记录"><div className="events-label"><span className="event-indicator"/>处理记录</div>{project.events?.length ? <ol className="event-list">{[...project.events].reverse().map((item, index) => <li key={`${item.at}-${index}`}><strong>{item.label}</strong><time dateTime={item.at} title={new Date(item.at).toLocaleString('zh-CN')}>{eventTime(item.at)}</time></li>)}</ol> : <span className="event-placeholder">此录音没有历史节点</span>}</section>
          <div className="workspace">
            <div className="audio-column">
              <section className="card audio-card"><div className="section-heading"><h3>音频</h3><span>{clock(time)} / {clock(duration || project.duration || 0)}</span></div><div ref={waveRef} className="wave"/><div className="wave-zoom"><label htmlFor="wave-zoom">波形范围</label><select id="wave-zoom" value={zoomWindow} disabled={!duration} onChange={event => zoomTo(Number(event.target.value))}><option value={0}>整段录音</option><option value={300}>附近 5 分钟</option><option value={60}>附近 1 分钟</option><option value={15}>附近 15 秒</option></select></div><div className="controls"><button onClick={() => seek(time - 5)}>−5s</button><button className="play" onClick={() => wsRef.current?.playPause()}>{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button><button onClick={() => seek(time + 5)}>+5s</button><label>速度 <select value={speed} onChange={event => {const value = Number(event.target.value); setSpeed(value); wsRef.current?.setPlaybackRate(value)}}>{[0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label></div></section>
              <section className="card transcribe-card">
                <button className="transcribe-toggle" type="button" aria-expanded={settingsOpen || transcribing} disabled={transcribing} onClick={() => setSettingsOpen(value => !value)}><span><strong>转写设置</strong><small>{transcribing ? `转写中 · ${percent}%` : status === 'ready' ? '选择模型并开始转写' : '模型、语言与重新转写'}</small></span><span className={`chevron ${settingsOpen || transcribing ? 'open' : ''}`}>⌄</span></button>
                {(settingsOpen || transcribing) && <div className="settings-body" tabIndex={0} role="region" aria-label="转写设置内容">
                  <div className="transcribe-controls"><label>引擎<select value={engine} disabled={transcribing} onChange={event => setEngine(event.target.value as 'webgpu' | 'wasm')}><option value="wasm">浏览器 CPU</option><option value="webgpu" disabled={!health?.webgpu}>浏览器 GPU（试验）</option></select></label><label>模型<select value={model} aria-describedby="model-description" disabled={transcribing} onChange={event => {const next = event.target.value; setModel(next); if (next !== 'large-v3' && language === 'yue') setLanguage('zh'); }}>{modelChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label} · {choice.size}</option>)}</select></label><label>语言<select value={language} disabled={transcribing} onChange={event => setLanguage(event.target.value)}><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="auto">自动识别</option><option value="yue" disabled={model !== 'large-v3'}>粤语（large-v3）</option></select></label></div>
                  <div id="model-description" className="model-description" aria-live="polite"><div><strong>{selectedModel.label}</strong><span>模型文件 {selectedModel.size}</span></div><p>{selectedModel.description}</p><small>{selectedModel.tradeoff} · 文件大小不等于运行内存</small></div>
                  <p className="language-note">首次使用所选模型需要下载（{selectedModel.size}），随后通常使用这台电脑的浏览器缓存。清除缓存后需要重新下载。转写时请保持页面打开；CPU 速度取决于本机性能。</p><div className="task-actions"><button className="primary" disabled={busy || transcribing || dirty} onClick={transcribe}>{status === 'done' || status === 'cancelled' ? '重新转写' : transcribing ? '正在转写…' : '开始转写'}</button>{transcribing && <button className="danger" disabled={busy || status === 'cancelling'} onClick={cancel}>{status === 'cancelling' ? '正在终止…' : '终止转写'}</button>}</div>
                  {transcribing && <div className="progress-wrap"><div className="progress-label"><span>{status === 'queued' ? (project.modelStatus || '正在启动模型…') : status === 'cancelling' ? '正在终止…' : `正在转写 · 已输出 ${project.segments.length} 段`}</span><strong>{percent}%</strong></div><div className="progress-track" role="progressbar" aria-label="转写进度" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div style={{width: `${percent}%`}}/></div></div>}
                  {status === 'cancelled' && <p className="hint">转写已终止，已完成的内容可以编辑和导出。</p>}{project.error && <p className="error">{project.error}</p>}
                </div>}
              </section>

            </div>
            <section className="card transcript" ref={transcriptRef}>
              <div className="transcript-head">
                <div className="section-heading"><div><h3>文字稿</h3><small>单击定位播放 · 双击原位修改</small></div><div className="save-area"><span className={dirty ? 'unsaved' : ''}>{transcribing ? '实时更新中' : saving ? '保存中…' : dirty ? '待保存' : '已保存'}</span><button onClick={save} disabled={!dirty || saving || transcribing}>保存</button></div></div>
                <div className="transcript-tools"><div className="search-field"><input ref={searchRef} type="search" aria-label="搜索文字稿" placeholder="搜索文字稿，找到后跳转音频" value={search} onFocus={() => {setSearchOpen(true); setVersionsOpen(false)}} onChange={event => {setSearch(event.target.value); setSearchIndex(0); setSearchOpen(true)}} onKeyDown={event => {if (event.key === 'Enter') jumpToMatch(searchIndex); if (event.key === 'Escape') {setSearchOpen(false); event.currentTarget.blur()}}}/><span>{search.trim() ? `${matches.length} 处` : '⌘F'}</span></div><button type="button" onClick={() => jumpToMatch(searchIndex - 1)} disabled={!matches.length} aria-label="上一个搜索结果">↑</button><button type="button" onClick={() => jumpToMatch(searchIndex + 1)} disabled={!matches.length} aria-label="下一个搜索结果">↓</button><button type="button" onClick={undo} disabled={!undoStack.current.length || transcribing} title="撤销（⌘Z）">撤销</button><button type="button" onClick={redo} disabled={!redoStack.current.length || transcribing} title="重做（⇧⌘Z）">重做</button><button type="button" className={versionsOpen ? 'active-tool' : ''} onClick={() => {setVersionsOpen(!versionsOpen); setSearchOpen(false); if (!versionsOpen) loadVersions(project.id)}}>历史版本</button></div>
                {selectedSegment && !transcribing && <div className="edit-actions"><span>已选 {clock(selectedSegment.start)}</span><button onClick={splitAtSelected} disabled={selectedGroup[0].id === selectedSegment.id}>从这里分段</button></div>}
                {searchOpen && search.trim() && <div className="search-results" aria-label="搜索结果">{matches.length ? matches.slice(0, 40).map((segment, index) => <button key={segment.id} onClick={() => jumpToMatch(index)}><time>{clock(segment.start)}</time><span>{segment.text.slice(0, 90)}</span></button>) : <p>没有找到匹配文字</p>}{matches.length > 40 && <p>显示前 40 处；可用 ↑ ↓ 浏览全部结果。</p>}</div>}
                {versionsOpen && <div className="versions-panel" aria-label="历史版本">{versions.length ? versions.map(item => <div className="version-row" key={item.revision}><div><strong>版本 {item.revision} · {item.label}</strong><small>{new Date(item.at).toLocaleString('zh-CN')}</small>{item.preview && <p>{item.preview}</p>}</div><button disabled={versionsBusy || transcribing || dirty} onClick={() => restoreVersion(item.revision)}>恢复</button></div>) : <p>首次修改并保存后，这里会保留最近 30 个版本。</p>}</div>}
              </div>
              {groups.length === 0 ? <p className="hint">{transcribing ? '正在识别音频，文字会陆续显示在这里…' : '转写完成后，文字会以连续段落显示在这里。'}</p> : groups.map((group, index) =>
                <div className="paragraph-block" key={`${group[0].id}-${index}`}>
                  <div className="paragraph-meta"><button className="time-link" onClick={() => {seek(group[0].start); wsRef.current?.play()}}>{clock(group[0].start)}</button>{speakerEditingId === group[0].id ? <input autoFocus aria-label="说话人名称" maxLength={60} value={speakerDraft} onChange={event => setSpeakerDraft(event.target.value)} onBlur={() => setGroupSpeaker(group, speakerDraft)} onKeyDown={event => {if (event.key === 'Enter') event.currentTarget.blur()}}/> : <button className={`speaker-button ${group[0].speaker ? 'named' : ''}`} disabled={transcribing} onClick={() => {setSpeakerDraft(group[0].speaker || ''); setSpeakerEditingId(group[0].id)}}>{group[0].speaker || '＋ 说话人'}</button>}{index > 0 && <button className="merge-button" disabled={transcribing} onClick={() => mergeWithPrevious(group, index)}>合并上段</button>}</div>
                  <p className="paragraph-text">{group.map((segment, offset) => editingSegmentId === segment.id && !transcribing
                    ? <span className="inline-edit" key={segment.id}>{prefix(group[offset - 1], segment)}<span className="inline-edit-field"><span className="inline-edit-mirror" aria-hidden="true">{segment.text || '\u200b'}{'\u200b'}</span><textarea autoFocus aria-label={`修改 ${clock(segment.start)} 的文字`} value={segment.text} rows={1} onChange={event => edit(segment.id, event.target.value)} onBlur={() => {editSession.current = null; setEditingSegmentId(null)}} onKeyDown={event => {if (event.key === 'Escape') event.currentTarget.blur(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {event.currentTarget.blur(); saveRef.current()}}}/></span></span>
                    : <span key={segment.id} data-segment-id={segment.id} ref={active === segment.id ? activeRef : undefined} role="button" tabIndex={0} title={`${clock(segment.start)} · 单击播放，双击修改`} className={`text-fragment ${active === segment.id ? 'active' : ''} ${selectedSegmentId === segment.id ? 'selected' : ''}`} onClick={event => clickSegment(segment, event)} onDoubleClick={event => {event.preventDefault(); beginEdit(segment)}} onKeyDown={event => {if (event.key === 'Enter') jumpToSegment(segment); if (event.key === 'F2') beginEdit(segment)}}>{prefix(group[offset - 1], segment)}{highlightText(segment.text, search)}</span>)}</p>
                </div>)}
            </section>
          </div>
        </>}
      </main>
    </div>
    {drag && <div className="drop-overlay" aria-hidden="true"><div>将音频或视频放到这里导入</div></div>}
    {importProgress && !hiddenProgress.import ? <ProgressDialog progress={importProgress} onHide={() => setHiddenProgress(previous => ({...previous, import: true}))}/>
      : modelProgress && !hiddenProgress.model ? <ProgressDialog progress={modelProgress} onHide={() => setHiddenProgress(previous => ({...previous, model: true}))}/> : null}
    {message && <div className="toast" role="status">{message}<button onClick={() => setMessage('')}>×</button></div>}
  </div>
}
