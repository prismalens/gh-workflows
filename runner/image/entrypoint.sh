#!/bin/bash
# The container runs with --network none; its one way out is the daemon's key proxy on a unix
# socket, bridged here to 127.0.0.1:8787 (#184, spec Q2).
set -euo pipefail
if [ -S /run/assayer/proxy.sock ]; then
  socat TCP4-LISTEN:8787,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/assayer/proxy.sock &
  i=0
  while ! (echo > /dev/tcp/127.0.0.1/8787) 2>/dev/null && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.05; done
fi
exec "$@"
