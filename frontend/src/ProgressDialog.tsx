import {useEffect, useRef} from 'react'
import {bytes, type TaskProgress} from './progress'

const fileLabel = (name: string) => name.includes('encoder_model') ? '音频识别组件'
  : name.includes('decoder_model') ? '文字生成组件'
  : name.includes('tokenizer') ? '语言词表' : name.endsWith('.json') ? '模型配置' : name

export default function ProgressDialog({progress, onHide}: {progress: TaskProgress; onHide: () => void}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {ref.current?.showModal(); return () => ref.current?.close()}, [])
  const percent = progress.percent === undefined ? undefined : Math.max(0, Math.min(100, progress.percent))
  return <dialog ref={ref} className="task-dialog" aria-labelledby="task-dialog-title" onCancel={event => {event.preventDefault(); onHide()}}>
    <div className="task-dialog-heading"><h2 id="task-dialog-title">{progress.kind === 'import' ? '导入音视频' : '准备转写模型'}</h2><button onClick={onHide} aria-label="收起进度弹窗">×</button></div>
    <p className="task-stage" role="status">{progress.stage}</p>
    <progress aria-label={progress.kind === 'import' ? '导入进度' : '模型下载进度'} max={100} value={percent}/>
    <div className="task-progress-value">{percent === undefined ? '正在处理…' : `${Math.floor(percent)}%`}{progress.loaded !== undefined && <span>{bytes(progress.loaded)}{progress.total ? ` / ${bytes(progress.total)}` : ''}</span>}</div>
    {progress.detail && <p className="task-detail">{progress.kind === 'model' ? fileLabel(progress.detail) : progress.detail}</p>}
    {!!progress.files?.length && <ul className="task-files">{progress.files.map(file => <li key={file.name}><span>{fileLabel(file.name)}</span><small>{bytes(file.loaded)}{file.total ? ` / ${bytes(file.total)}` : ''}</small></li>)}</ul>}
    <p className="task-privacy">{progress.kind === 'import' ? '文件在本机读取、解码和保存，录音不会上传。' : '仅下载公开模型文件，录音和文字稿不会上传。'}收起弹窗后任务会继续。</p>
  </dialog>
}
