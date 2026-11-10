#!/bin/sh
# worker 容器启动脚本（tini 的 CMD；保持 tini 为 PID1，最后 exec node 让 node 接管进程）。
#
# 背景：k8s 的 worker-home PVC 挂在 /root，会**遮住镜像里的 /root/.agent-browser**；
# 镜像因此把 Chrome for Testing 放在 /opt/agent-browser（镜像层，不受 PVC 影响）。
# 这里在 PVC 里还没有 browsers 时建一个符号链接，让 agent-browser 在重启后也能直接
# 找到镜像内置的 Chrome（而不是运行时重新下载，或被缺库/无外网卡住）。
# state/session/cookie 仍写 /root/.agent-browser（PVC 持久化），不影响既有登录态。
set -eu

BROWSERS_DIR="/opt/agent-browser/browsers"
if [ -d "$BROWSERS_DIR" ] && [ ! -e /root/.agent-browser/browsers ] && [ ! -L /root/.agent-browser/browsers ]; then
  mkdir -p /root/.agent-browser
  ln -s "$BROWSERS_DIR" /root/.agent-browser/browsers
fi

exec node dist/index.js
