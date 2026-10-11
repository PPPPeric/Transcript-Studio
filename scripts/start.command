#!/bin/zsh
set -e
cd "${0:A:h}/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo '此启动脚本用于 macOS；Windows 安装版尚未提供。'
  exit 1
fi
LTS_PYTHON=${LTS_PYTHON:-python3.13}
for tool in "$LTS_PYTHON" node npm ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null; then
    echo "缺少 $tool。请先安装：brew install python@3.13 node ffmpeg"
    exit 1
  fi
done
"$LTS_PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 13), "请使用 Python 3.13"'
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) {console.error("需要 Node.js 20 或更新版本"); process.exit(1)}'
if [[ ! -d .venv ]]; then
  "$LTS_PYTHON" -m venv .venv
fi
. .venv/bin/activate
python -c 'import sys; assert sys.version_info[:2] == (3, 13), "已有虚拟环境不是 Python 3.13，请将 .venv 重命名备份后重新启动"'
python - <<'PY'
import socket
with socket.socket() as sock:
    try:
        sock.bind(('127.0.0.1', 8000))
    except OSError:
        raise SystemExit('8000 端口已被占用。请关闭此前启动的服务后重试。')
PY
DEPENDENCY_HASH=$(cat backend/requirements.txt backend/requirements-mlx.txt backend/requirements-faster.txt | shasum -a 256 | cut -d ' ' -f 1)
if [[ ! -f .venv/.deps-hash || "$(cat .venv/.deps-hash)" != "$DEPENDENCY_HASH" ]]; then
  if [[ "$(uname -m)" == arm64 ]]; then
    python -m pip install -r backend/requirements-mlx.txt || {
      echo 'MLX 安装失败，继续安装 faster-whisper。'
    }
  fi
  python -m pip install -r backend/requirements-faster.txt
  echo "$DEPENDENCY_HASH" > .venv/.deps-hash
fi
export NPM_CONFIG_CACHE="$PWD/.npm-cache"
export HF_HOME="$PWD/.model-cache"
FRONTEND_HASH=$(cat frontend/package.json frontend/package-lock.json | shasum -a 256 | cut -d ' ' -f 1)
if [[ ! -f frontend/node_modules/.deps-hash || "$(cat frontend/node_modules/.deps-hash)" != "$FRONTEND_HASH" ]]; then
  (cd frontend && npm ci)
  echo "$FRONTEND_HASH" > frontend/node_modules/.deps-hash
fi
(cd frontend && npm run build)
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; wait $SERVER_PID 2>/dev/null || true' EXIT INT TERM
READY=0
for attempt in {1..60}; do
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo '服务启动失败，请查看上面的错误信息。'
    exit 1
  fi
  if python - <<'PY'
import json
import sys
import urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:8000/openapi.json', timeout=1) as response:
        document = json.load(response)
    sys.exit(0 if document['info']['title'] == 'LLJ Transcript Studio' else 1)
except Exception:
    sys.exit(1)
PY
  then
    READY=1
    break
  fi
  sleep 0.25
done
if [[ "$READY" != 1 ]]; then
  echo '等待服务启动超时，请查看上面的错误信息。'
  exit 1
fi
open http://127.0.0.1:8000
wait $SERVER_PID
