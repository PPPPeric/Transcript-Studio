"""Isolated ASR process. The API can terminate it without losing saved segments."""

import json
import sys
import wave

from .main import Segment, Transcribe, add_event, path, read, write

CHUNK_SECONDS = 30


def progress(pid: str, position: float, duration: float) -> None:
    doc = read(pid)
    value = min(99, max(doc.get('progress', 0), round(position / duration * 100, 1))) if duration else 99
    doc.update(status='transcribing', progress=value)
    write(doc)


def append(pid: str, start: float, end: float, text: str, duration: float) -> None:
    content = text.strip()
    if not content:
        return
    doc = read(pid)
    segment = Segment(id=len(doc['segments']), start=max(0, start),
                      end=max(start, end), text=content).model_dump()
    doc['segments'].append(segment)
    doc['revision'] += 1
    doc['progress'] = min(99, max(doc.get('progress', 0), round(end / duration * 100, 1))) if duration else 99
    doc['status'] = 'transcribing'
    write(doc)


def mlx_segments(pid: str, source: str, options: Transcribe, duration: float) -> None:
    import mlx_whisper

    chunk_path = path(pid) / '.chunk.wav'
    language = None if options.language == 'auto' else options.language
    with wave.open(source, 'rb') as audio:
        rate = audio.getframerate()
        frames_per_chunk = rate * CHUNK_SECONDS
        total_frames = audio.getnframes()
        for first_frame in range(0, total_frames, frames_per_chunk):
            audio.setpos(first_frame)
            frames = audio.readframes(min(frames_per_chunk, total_frames - first_frame))
            with wave.open(str(chunk_path), 'wb') as chunk:
                chunk.setnchannels(audio.getnchannels())
                chunk.setsampwidth(audio.getsampwidth())
                chunk.setframerate(rate)
                chunk.writeframes(frames)
            offset = first_frame / rate
            result = mlx_whisper.transcribe(
                str(chunk_path), path_or_hf_repo=f'mlx-community/whisper-{options.model}-mlx',
                language=language, verbose=None)
            for item in result['segments']:
                append(pid, offset + float(item['start']), offset + float(item['end']),
                       item['text'], duration)
            progress(pid, min(duration, (first_frame + len(frames) // (audio.getnchannels() * audio.getsampwidth())) / rate), duration)
    chunk_path.unlink(missing_ok=True)


def faster_segments(pid: str, source: str, options: Transcribe, duration: float) -> None:
    from faster_whisper import WhisperModel

    model = WhisperModel(options.model, device='cpu', compute_type='int8')
    language = None if options.language == 'auto' else options.language
    stream, _ = model.transcribe(source, language=language)
    for item in stream:
        append(pid, item.start, item.end, item.text, duration)


def main() -> None:
    pid = sys.argv[1]
    options = Transcribe.model_validate(json.loads(sys.argv[2]))
    doc = read(pid)
    doc.update(status='transcribing', error=None)
    write(doc)
    source = str(path(pid) / 'audio.wav')
    with wave.open(source, 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
    if options.engine == 'mlx':
        mlx_segments(pid, source, options, duration)
    else:
        faster_segments(pid, source, options, duration)
    doc = read(pid)
    doc.update(status='done', progress=100, error=None)
    add_event(doc, 'transcribe_finished', '转写完成')
    write(doc)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        try:
            doc = read(sys.argv[1])
            doc.update(status='error', error=f'{type(exc).__name__}: {exc}。已完成的文字仍保留。')
            add_event(doc, 'transcribe_failed', '转写失败')
            write(doc)
        finally:
            raise
