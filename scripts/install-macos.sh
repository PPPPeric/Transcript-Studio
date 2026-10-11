#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export LTS_PORT=${LTS_PORT:-8001}
export LTS_INSTALL_ROOT="$PWD"
if [[ $# -gt 1 || ( $# == 1 && "$1" != --prepare-only ) ]]; then
  echo '用法：scripts/install-macos.sh [--prepare-only]'
  exit 1
fi
export LTS_SITE_PYTHON=$(command -v "${LTS_SITE_PYTHON:-python3}")
LTS_PREPARE_ONLY=1 ./scripts/start.command
mkdir -p .runtime/logs
"$LTS_SITE_PYTHON" - <<'PY'
import os
import pathlib
import plistlib

root = pathlib.Path(os.environ['LTS_INSTALL_ROOT'])
port = int(os.environ['LTS_PORT'])
if not 1 <= port <= 65535:
    raise SystemExit('LTS_PORT 必须在 1 到 65535 之间')
service = {
    'Label': 'local.llj-transcript-studio.server',
    'WorkingDirectory': str(root),
    'ProgramArguments': [os.environ['LTS_SITE_PYTHON'], str(root / 'scripts/serve-browser.py'), '--port', str(port)],
    'EnvironmentVariables': {
        'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'PYTHONUNBUFFERED': '1',
    },
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'ExitTimeOut': 30,
    'StandardOutPath': str(root / '.runtime/logs/server.log'),
    'StandardErrorPath': str(root / '.runtime/logs/server-error.log'),
}
with (root / '.runtime/local.llj-transcript-studio.server.plist').open('wb') as out:
    plistlib.dump(service, out)
PY
plutil -lint .runtime/local.llj-transcript-studio.server.plist
if [[ "${1:-}" == --prepare-only ]]; then
  echo '后台启动配置已生成，尚未安装。'
  exit 0
fi
SERVICE=local.llj-transcript-studio.server
DOMAIN="gui/$(id -u)"
# Only replace this project's existing service.
launchctl bootout "$DOMAIN/$SERVICE" 2>/dev/null || true
"$LTS_SITE_PYTHON" - <<'PY'
import os
import socket
import time
for attempt in range(60):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', int(os.environ['LTS_PORT'])))
            break
        except OSError:
            if attempt == 59:
                raise SystemExit('端口已被占用，请先停止手动启动的服务，或设置 LTS_PORT 后重试。')
    time.sleep(0.5)
PY
mkdir -p "$HOME/Library/LaunchAgents"
cp ".runtime/$SERVICE.plist" "$HOME/Library/LaunchAgents/$SERVICE.plist"
launchctl enable "$DOMAIN/$SERVICE"
INSTALLED=0
# launchd can still be removing the old job after its port has been released.
for attempt in {1..20}; do
  if launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$SERVICE.plist" 2>.runtime/logs/bootstrap-error.log; then
    INSTALLED=1
    break
  fi
  sleep 0.5
done
if [[ "$INSTALLED" != 1 ]]; then
  cat .runtime/logs/bootstrap-error.log
  exit 1
fi
"$LTS_SITE_PYTHON" - <<'PY'
import json
import os
import time
import urllib.request
url = f'http://127.0.0.1:{os.environ["LTS_PORT"]}'
for _ in range(60):
    try:
        with urllib.request.urlopen(url + '/health.json', timeout=1) as response:
            if json.load(response)['mode'] == 'browser-local':
                print(f'后台服务已启动：{url}；以后登录 macOS 时会自动启动。')
                break
    except Exception:
        pass
    time.sleep(0.5)
else:
    raise SystemExit('服务尚未就绪，请查看 .runtime/logs/server-error.log。')
PY
