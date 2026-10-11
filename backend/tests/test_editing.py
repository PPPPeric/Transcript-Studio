import tempfile
import unittest
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from app import main


class EditingWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous_data = main.DATA
        main.DATA = Path(self.directory.name)
        self.pid = str(uuid.uuid4())
        (main.DATA / self.pid).mkdir()
        self.original = [
            {'id': 0, 'start': 0.0, 'end': 2.0, 'text': '第一句。'},
            {'id': 1, 'start': 8.0, 'end': 10.0, 'text': '第二句。'},
        ]
        main.write({'id': self.pid, 'name': '测试录音', 'status': 'done',
                    'error': None, 'revision': 0, 'segments': self.original,
                    'progress': 100, 'duration': 10})
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main.DATA = self.previous_data
        self.directory.cleanup()

    def test_edit_history_restore_and_exports(self):
        edited = [
            {**self.original[0], 'text': '改过的第一句。', 'speaker': '讲者 A'},
            {**self.original[1], 'paragraphStart': True, 'speaker': '讲者 A'},
        ]
        response = self.client.put(f'/api/projects/{self.pid}', json={'revision': 0, 'segments': edited})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['revision'], 1)
        versions = self.client.get(f'/api/projects/{self.pid}/versions').json()
        self.assertEqual([item['revision'] for item in versions], [1, 0])
        markdown = self.client.get(f'/api/projects/{self.pid}/export/md').text
        self.assertIn('**讲者 A：** 改过的第一句。', markdown)
        self.assertIn('**讲者 A：** 第二句。', markdown)
        srt = self.client.get(f'/api/projects/{self.pid}/export/srt').text
        self.assertIn('讲者 A：改过的第一句。', srt)

        restored = self.client.post(f'/api/projects/{self.pid}/restore',
                                    json={'revision': 0, 'current_revision': 1})
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json()['segments'], self.original)
        self.assertEqual(restored.json()['revision'], 2)
        self.assertEqual([item['revision'] for item in self.client.get(f'/api/projects/{self.pid}/versions').json()], [2, 1, 0])

    def test_manual_merge_overrides_automatic_gap(self):
        merged = [self.original[0], {**self.original[1], 'paragraphStart': False}]
        self.assertEqual(len(main.paragraph_groups(merged)), 1)
        self.assertEqual(len(main.paragraph_groups(self.original)), 2)

    def test_time_axis_cannot_be_edited(self):
        changed_time = [{**self.original[0], 'start': 1}, self.original[1]]
        response = self.client.put(f'/api/projects/{self.pid}',
                                   json={'revision': 0, 'segments': changed_time})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(main.read(self.pid)['revision'], 0)


if __name__ == '__main__':
    unittest.main()
