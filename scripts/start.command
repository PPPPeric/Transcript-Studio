#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export LTS_PORT=${LTS_PORT:-8001}
LTS_SITE_PYTHON=${LTS_SITE_PYTHON:-python3}
if [[ "$(uname -s)" != Darwin ]]; then
  echo '此启动脚本用于 macOS。'
  exit 1
fi
for tool in "$LTS_SITE_PYTHON" node npm; do
  command -v "$tool" >/dev/null || {echo "缺少 $tool，请先安装宿主机依赖"; exit 1;}
done
export NPM_CONFIG_CACHE="$PWD/.npm-cache"
for model in tiny base small medium large-v3; do
  MODEL_REPO="Xenova/whisper-$model"
  [[ "$model" != large-v3 ]] || MODEL_REPO="onnx-community/whisper-large-v3-ONNX"
  if [[ ! -f ".browser-models/$MODEL_REPO/onnx/decoder_model_merged_quantized.onnx" || ! -f ".browser-models/$MODEL_REPO/onnx/encoder_model_quantized.onnx" ]]; then
    "$LTS_SITE_PYTHON" scripts/download-browser-models.py --models "$model" --proxy "${LTS_MODEL_PROXY:-}"
  fi
done
"$LTS_SITE_PYTHON" scripts/prepare_browser_model.py .browser-models/Xenova/whisper-medium/onnx/encoder_model_quantized.onnx
FRONTEND_HASH=$(cat frontend/package.json frontend/package-lock.json | shasum -a 256 | cut -d ' ' -f 1)
if [[ ! -x frontend/node_modules/.bin/tsc || ! -x frontend/node_modules/.bin/vite || ! -f frontend/node_modules/.deps-hash || "$(cat frontend/node_modules/.deps-hash)" != "$FRONTEND_HASH" ]]; then
  (cd frontend && npm ci --include=dev)
  echo "$FRONTEND_HASH" > frontend/node_modules/.deps-hash
fi
(cd frontend && npm run build)
if [[ "${LTS_PREPARE_ONLY:-0}" == 1 ]]; then exit 0; fi
"$LTS_SITE_PYTHON" scripts/serve-browser.py --port "$LTS_PORT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; wait $SERVER_PID 2>/dev/null || true' EXIT INT TERM
READY=0
for attempt in {1..60}; do
  kill -0 $SERVER_PID 2>/dev/null || {echo '网页服务启动失败，若已安装后台服务，请直接打开页面。'; exit 1;}
  if "$LTS_SITE_PYTHON" - <<'CHECK'
import json, os, urllib.request
with urllib.request.urlopen(f'http://127.0.0.1:{os.environ["LTS_PORT"]}/health.json', timeout=1) as response:
    assert json.load(response)['mode'] == 'browser-local'
CHECK
  then READY=1; break; fi
  sleep 0.5
done
[[ "$READY" == 1 ]] || {echo '等待网页服务超时'; exit 1;}
open "http://127.0.0.1:$LTS_PORT"
wait $SERVER_PID
