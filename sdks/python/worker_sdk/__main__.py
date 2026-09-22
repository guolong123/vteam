"""CLI：``python -m worker_sdk`` 以独立进程启动 WorkerService（模拟控制面）。

示例::

    python -m worker_sdk --port 13999 --token dev-token
    # worker 侧: SERVER_URL=http://<host>:13999 X_WORKER_TOKEN=dev-token
"""

from __future__ import annotations

import argparse
import signal
import sys
import threading

from .service import WorkerService


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m worker_sdk",
        description="启动 WorkerService（模拟 vteam server：register/heartbeat/events）",
    )
    p.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    p.add_argument("--port", type=int, default=13999, help="控制面端口（默认 13999）")
    p.add_argument(
        "--token",
        required=True,
        help="与 worker X_WORKER_TOKEN 一致的共享 token",
    )
    p.add_argument(
        "--worker-exec-url",
        default=None,
        help="可选：显式 worker 执行端点（缺省按注册 capabilities 发现）",
    )
    p.add_argument("--quiet", action="store_true", help="关闭 HTTP 访问日志")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    svc = WorkerService(
        host=args.host,
        port=args.port,
        token=args.token,
        worker_exec_url=args.worker_exec_url,
        verbose=not args.quiet,
    )
    svc.start()
    print(
        f"WorkerService listening\n"
        f"  worker SERVER_URL={svc.server_url}\n"
        f"  worker X_WORKER_TOKEN={svc.token}",
        flush=True,
    )

    stop = threading.Event()

    def _sig(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    stop.wait()
    svc.stop()
    print("WorkerService stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
