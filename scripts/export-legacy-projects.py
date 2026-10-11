"""Create private, local .lts backups of legacy Mac mini projects for manual import."""
import json
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

root = Path(__file__).resolve().parents[1]
destination = root / '.runtime/legacy-backups'
destination.mkdir(parents=True, exist_ok=True)
count = 0
for folder in (root / 'projects').iterdir():
    if not (folder / 'transcript.json').is_file() or not (folder / 'audio.wav').is_file():
        continue
    project = json.loads((folder / 'transcript.json').read_text())
    project.setdefault('events', [])
    project.setdefault('source_kind', 'audio')
    project.setdefault('revision', 0)
    project['versions'] = [json.loads(p.read_text()) for p in sorted((folder / 'versions').glob('*.json'))][-30:]
    project['status'] = 'done' if project.get('segments') else 'ready'
    project['runId'] = None
    project['modelStatus'] = ''
    with ZipFile(destination / (folder.name + '.lts'), 'w', compression=ZIP_STORED) as archive:
        archive.writestr('project.json', json.dumps(project, ensure_ascii=False))
        archive.write(folder / 'audio.wav', 'audio.wav')
    count += 1
print(f'已生成 {count} 个本地项目备份：{destination}；原数据保留。')
