#!/usr/bin/env python3
"""worker_sdk 最小示例：起控制面 → 提交执行 → 等待结果。

前置：
1. worker 已启动，且环境变量：
     SERVER_URL=http://127.0.0.1:13999
     X_WORKER_TOKEN=dev-token
2. 本机 Python >= 3.10，无需安装第三方依赖。

运行：
  cd sdks/python
  python3 examples/basic_usage.py
"""

from __future__ import annotations

import sys
import time

sys.path.insert(0, ".")

from worker_sdk import EventsServer, WorkerClient, execute_and_wait  # noqa: E402

TOKEN = "dev-token"
CONTROL_PORT = 13999
WORKER_EXEC = "http://127.0.0.1:4198"


def main() -> None:
    # 1. 启动内嵌控制面（worker 的 SERVER_URL 指向它）
    with EventsServer(port=CONTROL_PORT, token=TOKEN) as events:
        print(f"控制面已启动: {events.base_url}")
        print(f"请确认 worker 环境: SERVER_URL={events.base_url}  X_WORKER_TOKEN={TOKEN}")
        print("等待 worker 注册（30s 内无注册则退出）...\n")

        deadline = time.time() + 30
        while time.time() < deadline:
            workers = events.registered_workers()
            if workers:
                print(f"worker 已注册: {[w['workerId'] for w in workers]}\n")
                break
            time.sleep(1)
        else:
            print("超时：未检测到 worker 注册，请检查 worker 配置与网络", file=sys.stderr)
            return

        client = WorkerClient(WORKER_EXEC, token=TOKEN)

        # 2. 一站式提交 + 等待
        task_id = f"ext-{int(time.time())}"
        print(f"提交任务 task_id={task_id} ...")
        try:
            result = execute_and_wait(
                client,
                events,
                prompt="用一句话自我介绍。",
                task_id=task_id,
                timeout=120,
                directory="/tmp/worker-sdk-demo",
                system="你是第三方服务调用的演示 agent。",
            )
        except Exception as exc:  # noqa: BLE001
            print(f"执行失败/超时: {exc}", file=sys.stderr)
            return

        print("\n=== 执行完成 ===")
        print(f"session_id : {result.session_id}")
        print(f"status     : {result.status}")
        print(f"output     : {result.output}")
        print(f"raw payload: {result.payload}")


if __name__ == "__main__":
    main()
