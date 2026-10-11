"""Download public model assets only; never handles recording or project data."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--models', nargs='+', choices=['tiny', 'base', 'small'], default=['tiny', 'base', 'small'])
parser.add_argument('--proxy', default=None)
args = parser.parse_args()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': args.proxy} if args.proxy else {}))
root = Path(__file__).resolve().parents[1] / '.browser-models'

for model in args.models:
    repo = 'Xenova/whisper-' + model
    with opener.open('https://huggingface.co/api/models/' + repo, timeout=60) as response:
        metadata = json.load(response)
    revision = metadata['sha']
    source = root / repo / 'source.json'
    if source.is_file():
        revision = json.loads(source.read_text())['revision']
    names = [item['rfilename'] for item in metadata['siblings']
             if ('/' not in item['rfilename'] and item['rfilename'].endswith(('.json', '.txt', '.md')))
             or item['rfilename'] in ('onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx')]

    def download(name):
        target = root / repo / name
        if target.is_file() and target.stat().st_size:
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + '.partial')
        with opener.open(f'https://huggingface.co/{repo}/resolve/{revision}/{name}', timeout=120) as response, temp.open('wb') as out:
            while data := response.read(1024 * 1024):
                out.write(data)
        temp.replace(target)
        print(f'Downloaded {repo}/{name}', flush=True)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, names))
    (root / repo / 'source.json').write_text(json.dumps({'repository': repo, 'revision': revision}))
print('Public browser models ready in ' + str(root))
