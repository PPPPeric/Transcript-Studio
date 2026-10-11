import shutil
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from fastapi.testclient import TestClient

from app import main


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), '需要 FFmpeg 和 FFprobe')
class MediaImportTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous_data = main.DATA
        main.DATA = Path(self.directory.name) / 'projects'
        main.DATA.mkdir()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main.DATA = self.previous_data
        self.directory.cleanup()

    def make_video(self, with_audio: bool) -> Path:
        target = Path(self.directory.name) / ('with-audio.mp4' if with_audio else 'silent.mp4')
        command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                   'color=c=black:s=64x64:r=10:d=1']
        if with_audio:
            command += ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
                        '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac']
        command += ['-c:v', 'mpeg4', '-shortest', str(target)]
        subprocess.run(command, check=True, capture_output=True)
        return target

    def test_video_audio_is_extracted_for_transcription(self):
        video = self.make_video(with_audio=True)
        with video.open('rb') as source:
            response = self.client.post('/api/projects', files={'file': (video.name, source, 'video/mp4')})
        self.assertEqual(response.status_code, 201, response.text)
        doc = response.json()
        self.assertEqual(doc['source_kind'], 'video')
        self.assertEqual(doc['status'], 'ready')
        self.assertGreater(doc['duration'], 0)
        self.assertEqual([event['kind'] for event in doc['events']],
                         ['import_started', 'audio_extracted', 'import_finished'])
        folder = main.DATA / doc['id']
        self.assertFalse((folder / 'source').exists())
        with wave.open(str(folder / 'audio.wav'), 'rb') as audio:
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getframerate(), 16000)
        self.assertEqual(self.client.get(f"/api/projects/{doc['id']}/audio").status_code, 200)

    def test_video_without_audio_is_rejected_without_project(self):
        video = self.make_video(with_audio=False)
        with video.open('rb') as source:
            response = self.client.post('/api/projects', files={'file': (video.name, source, 'video/mp4')})
        self.assertEqual(response.status_code, 400)
        self.assertIn('没有音轨', response.json()['detail'])
        self.assertEqual(list(main.DATA.iterdir()), [])

    def test_audio_import_remains_available(self):
        audio = Path(self.directory.name) / 'tone.wav'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi',
                        '-i', 'sine=frequency=440:duration=1', str(audio)],
                       check=True, capture_output=True)
        with audio.open('rb') as source:
            response = self.client.post('/api/projects', files={'file': (audio.name, source, 'audio/wav')})
        self.assertEqual(response.status_code, 201, response.text)
        doc = response.json()
        self.assertEqual(doc['source_kind'], 'audio')
        self.assertEqual([event['kind'] for event in doc['events']],
                         ['import_started', 'import_finished'])


if __name__ == '__main__':
    unittest.main()
