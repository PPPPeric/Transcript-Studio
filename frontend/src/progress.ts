export type TaskProgress = {
  kind: 'import' | 'model'
  stage: string
  percent?: number
  detail?: string
  loaded?: number
  total?: number
  files?: {name: string; loaded: number; total?: number}[]
  start?: boolean
}

export function reportProgress(progress: TaskProgress) {
  window.dispatchEvent(new CustomEvent('lts-progress', {detail: progress}))
}

export function finishProgress(kind: TaskProgress['kind']) {
  window.dispatchEvent(new CustomEvent('lts-progress', {detail: {kind, finished: true}}))
}

export const bytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB`
  : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.ceil(value / 1e3)} KB`
