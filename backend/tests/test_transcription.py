import json
import os
import tempfile
import threading
import types
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from app import main, worker


class TranscriptionWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous_data = main.DATA
        main.DATA = Path(self.directory.name)
        self.pid = str(uuid.uuid4())
        (main.DATA / self.pid).mkdir()
        main.write({'id': self.pid, 'name': '测试录音', 'status': 'transcribing',
                    'error': None, 'revision': 1, 'segments': [], 'progress': 0,
                    'duration': 31, 'events': []})
        with wave.open(str(main.DATA / self.pid / 'audio.wav'), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b'\0' * (31 * 16000 * 2))

    def tearDown(self):
        main.processes.pop(self.pid, None)
        main.DATA = self.previous_data
        self.directory.cleanup()

    def run_worker(self, engine):
        options = main.Transcribe(engine=engine, model='tiny').model_dump_json()
        with patch('sys.argv', ['worker', self.pid, options]):
            worker.main()

    def test_faster_segments_are_saved_before_stream_finishes(self):
        def stream():
            yield types.SimpleNamespace(start=0, end=10, text='第一段中文。')
            partial = main.read(self.pid)
            self.assertEqual(len(partial['segments']), 1)
            self.assertEqual(partial['status'], 'transcribing')
            self.assertGreater(partial['progress'], 0)
            self.assertLess(partial['progress'], 100)
            yield types.SimpleNamespace(start=10, end=31, text='第二段中文。')
        model = Mock()
        model.transcribe.return_value = (stream(), None)
        module = types.SimpleNamespace(WhisperModel=Mock(return_value=model))
        with patch.dict('sys.modules', {'faster_whisper': module}):
            self.run_worker('faster')
        final = main.read(self.pid)
        self.assertEqual(final['status'], 'done')
        self.assertEqual(final['progress'], 100)
        self.assertEqual(len(final['segments']), 2)
        self.assertEqual(final['events'][-1]['kind'], 'transcribe_finished')

    def test_mlx_chunk_timestamps_are_absolute(self):
        calls = []
        def transcribe(source, **options):
            if calls:
                self.assertEqual(len(main.read(self.pid)['segments']), 1)
            calls.append(source)
            with wave.open(source, 'rb') as audio:
                duration = audio.getnframes() / audio.getframerate()
            return {'segments': [{'start': 0, 'end': duration, 'text': '片段。'}]}
        with patch.dict('sys.modules', {'mlx_whisper': types.SimpleNamespace(transcribe=transcribe)}):
            self.run_worker('mlx')
        final = main.read(self.pid)
        self.assertEqual([(s['start'], s['end']) for s in final['segments']], [(0, 30), (30, 31)])
        self.assertEqual(final['progress'], 100)
        self.assertFalse((main.DATA / self.pid / '.chunk.wav').exists())

    def test_cancel_preserves_worker_last_write(self):
        proc = Mock()
        main.processes[self.pid] = proc
        def stop(process):
            self.assertIs(process, proc)
            self.assertEqual(main.read(self.pid)['status'], 'transcribing')
            worker.append(self.pid, 0, 5, '终止前最后保存的句子。', 31)
        with patch.object(main, 'stop_process', side_effect=stop):
            final = main.cancel(self.pid)
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual(final['segments'][0]['text'], '终止前最后保存的句子。')
        self.assertNotIn(self.pid, main.processes)
        self.assertEqual(main.read(self.pid), final)

    def test_completion_during_cancel_remains_done(self):
        main.processes[self.pid] = Mock()
        def finish(process):
            doc = main.read(self.pid)
            doc.update(status='done', progress=100)
            main.add_event(doc, 'transcribe_finished', '转写完成')
            main.write(doc)
        with patch.object(main, 'stop_process', side_effect=finish):
            final = main.cancel(self.pid)
        self.assertEqual(final['status'], 'done')
        self.assertEqual(final['events'][-1]['kind'], 'transcribe_finished')

    def test_unexpected_process_exit_preserves_partial_transcript(self):
        worker.append(self.pid, 0, 5, '已保存。', 31)
        proc = Mock()
        proc.wait.return_value = 1
        main.processes[self.pid] = proc
        main.monitor(self.pid, proc)
        final = main.read(self.pid)
        self.assertEqual(final['status'], 'error')
        self.assertEqual(len(final['segments']), 1)
        self.assertEqual(final['events'][-1]['kind'], 'transcribe_failed')

    def test_restart_marks_interrupted_project_without_losing_text(self):
        worker.append(self.pid, 0, 5, '已保存。', 31)
        with TestClient(main.app) as client:
            final = client.get(f'/api/projects/{self.pid}').json()
        self.assertEqual(final['status'], 'error')
        self.assertEqual(len(final['segments']), 1)
        self.assertEqual(final['events'][-1]['kind'], 'interrupted')

    def test_concurrent_atomic_writes_use_different_temporary_files(self):
        barrier = threading.Barrier(2)
        original_replace = os.replace
        sources, errors = [], []
        def synchronized_replace(source, destination):
            sources.append(str(source))
            barrier.wait(timeout=5)
            return original_replace(source, destination)
        def write_text(text):
            try:
                main.write({'id': self.pid, 'text': text})
            except Exception as exc:
                errors.append(exc)
        with patch.object(main.os, 'replace', side_effect=synchronized_replace):
            threads = [threading.Thread(target=write_text, args=(text,))
                       for text in ['短句。', '比较长的中文句子。']]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=6)
        self.assertFalse(errors, errors)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(set(sources)), 2)
        final = json.loads((main.DATA / self.pid / 'transcript.json').read_text(encoding='utf-8'))
        self.assertIn(final['text'], ['短句。', '比较长的中文句子。'])
        self.assertFalse(list((main.DATA / self.pid).glob('.transcript-*.tmp')))


if __name__ == '__main__':
    unittest.main()
