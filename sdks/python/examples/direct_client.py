#!/usr/bin/env python3
"""WorkerDirect 直连模式示例：不启动控制面，直接连 worker 执行端点。

适用 worker 以 WORKER_STANDALONE=true 独立启动（不注册/心跳）。

前置：
1. worker 已启动，且环境变量（独立模式）：
     WORKER_STANDALONE=true
     X_WORKER_TOKEN=dev-token
     WORKER_EXEC_PORT=4198
2. 本机 Python >= 3.10，无需安装第三方依赖。

运行：
  cd sdks/python
  python3 examples/direct_client.py [worker_exec_url]

注意：直连模式无控制面，execute 为 fire-and-forget（202），拿不到执行结果；
需要结果请用 examples/basic_usage.py（WorkerService / EventsServer）。
"""

from __future__ import annotations

import sys

sys.path.insert(0, ".")

from worker_sdk import ServiceRequiredError, WorkerDirect  # noqa: E402

TOKEN = "dev-token"
WORKER_EXEC = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4198"


def main() -> None:
    with WorkerDirect(WORKER_EXEC, token=TOKEN) as worker:
        print(f"worker exec 端点: {worker.base_url}")

        if not worker.health():
            print("worker 不可达，退出")
            return

        print("health: ok")
        print(f"plan files: {worker.list_plan_files()}")
        print(f"write plan file: {worker.write_plan_file('direct-demo.md', '# hello from WorkerDirect')}")

        accepted = worker.execute(
            "写一个 hello world", task_id="t-direct-1", directory="/data/t-direct-1"
        )
        print(f"execute accepted={accepted.accepted} status={accepted.status}（结果经 events 回流，直连模式不等待）")

        try:
            worker.execute_and_wait("hi", task_id="t-direct-2")
        except ServiceRequiredError as exc:
            print(f"execute_and_wait 预期不可用: {exc}")


if __name__ == "__main__":
    main()
