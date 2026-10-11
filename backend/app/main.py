from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock, Thread
from typing import Literal
import importlib
import functools
import sys
import json
import os
import platform
import re
import signal
import shutil
import subprocess
import tempfile
import uuid
import wave

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault('HF_HOME', str(ROOT / '.model-cache'))
DATA = Path(os.environ.get('LTS_DATA_DIR', ROOT / 'projects'))
DATA.mkdir(parents=True, exist_ok=True)
lock = RLock()
processes: dict[str, subprocess.Popen] = {}
VERSION_LIMIT = 30


def path(pid):
    try:
        if str(uuid.UUID(pid)) != pid:
            raise ValueError()
    except ValueError:
        raise HTTPException(404, '项目不存在')
    p = DATA / pid
    if not (p / 'transcript.json').exists():
        raise HTTPException(404, '项目不存在')
    return p


def read(pid):
    return json.loads((path(pid) / 'transcript.json').read_text(encoding='utf-8'))


def atomic_json(destination: Path, payload):
    # Each writer needs its own file, including the separate ASR process.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                         dir=destination.parent, prefix='.transcript-',
                                         suffix='.tmp', delete=False) as out:
            temporary = Path(out.name)
            json.dump(payload, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write(doc):
    atomic_json(DATA / doc['id'] / 'transcript.json', doc)


def version_file(pid: str, revision: int) -> Path:
    return path(pid) / 'versions' / f'{revision}.json'


def snapshot(doc, label: str, preview: str = ''):
    folder = path(doc['id']) / 'versions'
    folder.mkdir(exist_ok=True)
    destination = version_file(doc['id'], doc['revision'])
    if destination.exists():
        return
    payload = {'revision': doc['revision'], 'at': datetime.now(timezone.utc).isoformat(),
               'label': label, 'preview': preview[:120], 'segments': doc['segments']}
    atomic_json(destination, payload)
    versions = sorted(folder.glob('*.json'), key=lambda item: int(item.stem))
    for old in versions[:-VERSION_LIMIT]:
        old.unlink()


def add_event(doc, kind: str, label: str, at: str | None = None):
    doc.setdefault('events', []).append({
        'kind': kind,
        'at': at or datetime.now(timezone.utc).isoformat(),
        'label': label,
    })


@asynccontextmanager
async def lifespan(app):
    for p in DATA.glob('*/transcript.json'):
        with lock:
            doc = json.loads(p.read_text(encoding='utf-8'))
            if doc['status'] in ('queued', 'transcribing', 'cancelling'):
                doc.update(status='error', error='上次转写被中断，请重新开始。')
                add_event(doc, 'interrupted', '转写中断')
                write(doc)
    yield
    with lock:
        for proc in processes.values():
            stop_process(proc)
        processes.clear()


app = FastAPI(title='LLJ Transcript Studio', lifespan=lifespan)


class Segment(BaseModel):
    id: int = Field(ge=0)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(ge=0, allow_inf_nan=False)
    text: str = Field(max_length=100000)
    paragraphStart: bool | None = None
    speaker: str | None = Field(default=None, max_length=60)

    @model_validator(mode='after')
    def times(self):
        if self.end < self.start:
            raise ValueError('end must be >= start')
        return self


class Edit(BaseModel):
    revision: int
    segments: list[Segment]


class RestoreVersion(BaseModel):
    revision: int = Field(ge=0)
    current_revision: int = Field(ge=0)


class Transcribe(BaseModel):
    engine: Literal['mlx', 'faster'] = 'mlx'
    model: Literal['tiny', 'base', 'small', 'medium', 'large-v3'] = 'base'
    language: Literal['zh', 'en', 'ja', 'yue', 'auto'] = 'zh'

    @model_validator(mode='after')
    def language_model(self):
        if self.language == 'yue' and self.model != 'large-v3':
            raise ValueError('粤语选项需要 large-v3 模型')
        return self


@functools.lru_cache(maxsize=2)
def available(module):
    if module == 'mlx_whisper':
        try:
            result = subprocess.run([sys.executable, '-c', 'import mlx_whisper'],
                                    capture_output=True, timeout=15)
            return result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False
    try:
        importlib.import_module(module)
        return True
    except Exception:
        return False


@app.get('/api/health')
def health():
    return {'engines': {k: available(v) for k, v in
                        [('mlx', 'mlx_whisper'), ('faster', 'faster_whisper')]},
            'apple_silicon': platform.system() == 'Darwin' and platform.machine() == 'arm64',
            'ffmpeg': all(shutil.which(tool) is not None for tool in ('ffmpeg', 'ffprobe'))}


@app.get('/api/projects')
def projects():
    with lock:
        docs = [json.loads(p.read_text(encoding='utf-8')) for p in DATA.glob('*/transcript.json')]
        return [{k: d[k] for k in ('id', 'name', 'status')} for d in reversed(docs)]


@app.post('/api/projects', status_code=201)
def upload(file: UploadFile = File(...)):
    if not all(shutil.which(tool) for tool in ('ffmpeg', 'ffprobe')):
        raise HTTPException(503, '缺少 FFmpeg/FFprobe，请执行 brew install ffmpeg')
    pid = str(uuid.uuid4())
    folder = DATA / pid
    folder.mkdir()
    started_at = datetime.now(timezone.utc).isoformat()
    try:
        with (folder / 'source').open('wb') as out:
            size = 0
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > 1024**3:
                    raise HTTPException(413, '文件超过 1 GB 限制')
                out.write(chunk)
        source = folder / 'source'
        try:
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                                    'stream=codec_type', '-of', 'json', str(source)],
                                   capture_output=True, timeout=60)
        except subprocess.TimeoutExpired:
            raise HTTPException(400, '读取媒体文件超时，请检查文件是否完整。')
        if probe.returncode:
            raise HTTPException(400, '无法识别媒体文件，请检查音频或视频是否有效。')
        streams = json.loads(probe.stdout).get('streams', [])
        is_video = any(stream.get('codec_type') == 'video' for stream in streams)
        if not any(stream.get('codec_type') == 'audio' for stream in streams):
            raise HTTPException(400, '视频没有音轨，无法转写。' if is_video else '文件没有可用音轨，无法转写。')
        try:
            result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i',
                                     str(source), '-map', '0:a:0', '-vn', '-ac', '1',
                                     '-ar', '16000', '-c:a', 'pcm_s16le',
                                     str(folder / 'audio.wav')], capture_output=True, timeout=1800)
        except subprocess.TimeoutExpired:
            raise HTTPException(400, '提取音频超时，请尝试较短的视频或音频。')
        if result.returncode:
            raise HTTPException(400, '无法提取视频音轨，请检查文件是否完整。' if is_video else '无法解码音频，请检查文件是否有效。')
        extracted_at = datetime.now(timezone.utc).isoformat()
        source.unlink()
        with wave.open(str(folder / 'audio.wav'), 'rb') as audio_file:
            duration = audio_file.getnframes() / audio_file.getframerate()
        doc = dict(id=pid, name=Path(file.filename or '媒体文件').name, status='ready',
                   error=None, revision=0, segments=[], progress=0, duration=duration,
                   source_kind='video' if is_video else 'audio')
        add_event(doc, 'import_started', '开始导入', started_at)
        if is_video:
            add_event(doc, 'audio_extracted', '视频音轨提取完成', extracted_at)
        add_event(doc, 'import_finished', '导入成功')
        with lock:
            write(doc)
        return doc
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    finally:
        file.file.close()


@app.get('/api/projects/{pid}')
def get_project(pid: str):
    with lock:
        return read(pid)


@app.get('/api/projects/{pid}/audio')
def audio(pid: str):
    return FileResponse(path(pid) / 'audio.wav', media_type='audio/wav')


@app.put('/api/projects/{pid}')
def save(pid: str, edit: Edit):
    with lock:
        doc = read(pid)
        if doc['status'] in ('queued', 'transcribing', 'cancelling'):
            raise HTTPException(409, '转写进行中，暂不能编辑')
        if edit.revision != doc['revision']:
            raise HTTPException(409, '项目已在其他窗口修改，请先复制当前文字再刷新')
        if [{k: getattr(s, k) for k in ('id', 'start', 'end')} for s in edit.segments] != [
                {k: s[k] for k in ('id', 'start', 'end')} for s in doc['segments']]:
            raise HTTPException(422, '仅支持编辑句子文字，不能修改时间轴')
        updated = [s.model_dump(exclude_none=True) for s in edit.segments]
        if updated == doc['segments']:
            return doc
        before = doc['segments']
        text_changes = sum(a['text'] != b['text'] for a, b in zip(before, updated))
        layout_changes = sum((a.get('paragraphStart'), a.get('speaker')) !=
                             (b.get('paragraphStart'), b.get('speaker')) for a, b in zip(before, updated))
        label = '、'.join(part for part in (f'修改 {text_changes} 处文字' if text_changes else '',
                                           f'调整 {layout_changes} 处段落或说话人' if layout_changes else '') if part)
        preview = next((b['text'] for a, b in zip(before, updated) if a != b), '')
        snapshot(doc, '编辑前原稿')
        doc.update(segments=updated, revision=doc['revision'] + 1)
        write(doc)
        snapshot(doc, label, preview)
        return doc


@app.get('/api/projects/{pid}/versions')
def versions(pid: str):
    with lock:
        folder = path(pid) / 'versions'
        if not folder.exists():
            return []
        files = sorted(folder.glob('*.json'), key=lambda item: int(item.stem), reverse=True)
        return [{k: record[k] for k in ('revision', 'at', 'label', 'preview')}
                for record in (json.loads(file.read_text(encoding='utf-8')) for file in files)]


@app.post('/api/projects/{pid}/restore')
def restore(pid: str, request: RestoreVersion):
    with lock:
        doc = read(pid)
        if doc['status'] in ('queued', 'transcribing', 'cancelling'):
            raise HTTPException(409, '转写进行中，暂不能恢复版本')
        if request.current_revision != doc['revision']:
            raise HTTPException(409, '项目已在其他窗口修改，请刷新后再恢复')
        source = version_file(pid, request.revision)
        if not source.exists():
            raise HTTPException(404, '历史版本不存在')
        older = json.loads(source.read_text(encoding='utf-8'))
        snapshot(doc, '恢复前版本')
        doc.update(segments=older['segments'], revision=doc['revision'] + 1,
                   status='done', progress=100, error=None)
        add_event(doc, 'version_restored', f'恢复到版本 {request.revision}')
        write(doc)
        snapshot(doc, f'恢复到版本 {request.revision}')
        return doc


def stop_process(proc: subprocess.Popen):
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=2)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


def monitor(pid: str, proc: subprocess.Popen):
    code = proc.wait()
    with lock:
        if processes.get(pid) is not proc:
            return
        processes.pop(pid, None)
        doc = read(pid)
        if doc['status'] in ('queued', 'transcribing'):
            if code == 0:
                doc.update(status='done', progress=100, error=None)
                add_event(doc, 'transcribe_finished', '转写完成')
            else:
                doc.update(status='error', error='转写进程意外退出；已完成的文字仍保留，可重新开始。')
                add_event(doc, 'transcribe_failed', '转写失败')
            write(doc)


@app.post('/api/projects/{pid}/transcribe', status_code=202)
def transcribe(pid: str, options: Transcribe):
    module = 'mlx_whisper' if options.engine == 'mlx' else 'faster_whisper'
    if not available(module):
        raise HTTPException(503, f'未安装 {module}，请按 README 安装对应引擎')
    with lock:
        doc = read(pid)
        if doc['status'] in ('queued', 'transcribing', 'cancelling'):
            raise HTTPException(409, '转写已在进行中')
        if doc['segments']:
            snapshot(doc, '重新转写前原稿')
        doc.update(status='queued', error=None, progress=0, segments=[], revision=doc['revision'] + 1,
                   transcription=options.model_dump())
        add_event(doc, 'transcribe_started', '开始转写')
        write(doc)
        env = os.environ.copy()
        env['PYTHONPATH'] = str(ROOT / 'backend')
        log = (path(pid) / 'worker.log').open('w', encoding='utf-8')
        try:
            proc = subprocess.Popen([sys.executable, '-m', 'app.worker', pid, options.model_dump_json()],
                                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as exc:
            doc.update(status='error', error=f'无法启动转写：{exc}')
            add_event(doc, 'transcribe_failed', '转写启动失败')
            write(doc)
            raise HTTPException(500, doc['error']) from exc
        finally:
            log.close()
        processes[pid] = proc
        Thread(target=monitor, args=(pid, proc), daemon=True).start()
        return doc


@app.post('/api/projects/{pid}/cancel')
def cancel(pid: str):
    with lock:
        doc = read(pid)
        if doc['status'] not in ('queued', 'transcribing', 'cancelling'):
            raise HTTPException(409, '当前没有进行中的转写')
        proc = processes.get(pid)
        if proc is None:
            raise HTTPException(409, '转写进程已结束，请刷新项目状态')
        # Do not overwrite a segment saved by the worker while it is stopping.
        stop_process(proc)
        processes.pop(pid, None)
        doc = read(pid)
        if doc['status'] == 'done':
            return doc
        doc.update(status='cancelled', error=None)
        add_event(doc, 'transcribe_cancelled', '手动终止转写')
        write(doc)
        return doc


def stamp(seconds, srt=False):
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{s:02}' + (f',{ms:03}' if srt else '')


def paragraph_groups(segments):
    """Use the same automatic and manual paragraph breaks as the transcript view."""
    groups = []
    current = []
    for segment in sorted(segments, key=lambda s: (s['start'], s['id'])):
        previous = current[-1] if current else None
        gap = segment['start'] - previous['end'] if previous else 0
        auto_break = (gap > 3.5 or len(current) >= 45 or
                      (len(current) >= 25 and segment['start'] - current[0]['start'] > 90))
        if current and (segment.get('paragraphStart') is True or
                        (segment.get('paragraphStart') is not False and auto_break)):
            groups.append(current)
            current = []
        current.append(segment)
    if current:
        groups.append(current)

    return groups


def text_paragraphs(segments):
    paragraphs = []
    for group in paragraph_groups(segments):
        parts = []
        previous = ''
        for segment in group:
            value = segment['text'].strip()
            if not value:
                continue
            if previous and re.search(r'[A-Za-z0-9.,!?;:)]$', previous) and re.match(r'[A-Za-z0-9(]', value):
                parts.append(' ')
            parts.append(value)
            previous = value
        paragraph = ''.join(parts)
        if paragraph:
            speaker = group[0].get('speaker')
            if speaker:
                paragraph = f'**{speaker}：** {paragraph}'
            paragraphs.append(paragraph)
    return paragraphs


@app.get('/api/projects/{pid}/export/{fmt}')
def export(pid: str, fmt: Literal['md', 'srt']):
    with lock:
        doc = read(pid)
    segments = doc['segments']
    if fmt == 'md':
        body = '# ' + doc['name'] + '\n\n' + '\n\n'.join(text_paragraphs(segments))
    else:
        body = '\n\n'.join(f"{i+1}\n{stamp(s['start'], True)} --> {stamp(s['end'], True)}\n{(s.get('speaker') + '：') if s.get('speaker') else ''}{s['text']}"
                           for i, s in enumerate(segments)) + '\n'
    return Response(body, media_type='text/plain',
                    headers={'Content-Disposition': f'attachment; filename="transcript.{fmt}"'})


DIST = ROOT / 'frontend' / 'dist'
if DIST.exists():
    app.mount('/', StaticFiles(directory=DIST, html=True), name='frontend')
