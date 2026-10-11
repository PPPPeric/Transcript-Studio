export type Segment = {id: number; start: number; end: number; text: string; paragraphStart?: boolean; speaker?: string}
export type Version = {revision: number; at: string; label: string; preview: string; segments: Segment[]}
export type Project = {id: string; name: string; status: string; error: string | null; revision: number; segments: Segment[]; progress: number; duration: number; events: {kind: string; at: string; label: string}[]; source_kind: 'audio' | 'video'; versions: Version[]; runId?: string; modelStatus?: string}
