#!/bin/zsh
set -euo pipefail
SERVICE=local.llj-transcript-studio.server
launchctl bootout "gui/$(id -u)/$SERVICE" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$SERVICE.plist"
echo '已停用后台自启动，项目、模型和转写数据保留。'
