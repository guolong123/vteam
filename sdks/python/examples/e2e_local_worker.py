#!/usr/bin/env python3
"""端到端联调：EventsServer + 真实 worker + execute_and_wait。

前置（已检查）：opencode CLI 在 PATH、worker/node_modules 与 dist 就绪。
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from worker_sdk import EventsServer, WorkerClient, execute_and_wait  # noqa: E402
from worker_sdk.exceptions import ExecuteError, TaskTimeoutError, WorkerError  # noqa: E402

TOKEN = "e2e-sdk-token"
CONTROL_PORT = 13997
EXEC_PORT = 4198
WORK_DIR = "/tmp/worker-sdk-demo"
REGISTER_WAIT_S = 60
EXEC_TIMEOUT_S = 180


def log(msg: str) -> None:
    print(f"\n{'=' * 60}\n{msg}\n{'=' * 60}", flush=True)


def main() -> int:
    work_dir = Path(WORK_DIR)
    work_dir.mkdir(parents=True, exist_ok=True)

    log("1. 启动 EventsServer（内嵌控制面）")
    events = EventsServer(host="127.0.0.1", port=CONTROL_PORT, token=TOKEN, verbose=True)
    events.start()
    print(f"控制面: {events.base_url}")

    log("2. 启动 worker（SERVER_URL 指向 EventsServer）")
    env = os.environ.copy()
    env.update(
        {
            "SERVER_URL": events.base_url,
            "X_WORKER_TOKEN": TOKEN,
            "WORKER_ID": "w_sdk_e2e",
            "WORKER_NAME": "sdk-e2e-worker",
            "WORK_DIR": str(work_dir),
            "WORKER_EXEC_PORT": str(EXEC_PORT),
            "OPENCODE_SERVE_HOSTNAME": "127.0.0.1",
            "OPENCODE_SERVE_PORT": "0",
            "HEARTBEAT_INTERVAL_MS": "10000",
            "LOG_LEVEL": "info",
            # 不设 WORKER_MCP_URL：桩返回空 mcp 列表即可
            "WORKER_DEFAULT_MODEL": env.get("WORKER_DEFAULT_MODEL", ""),
        }
    )
    # 清掉可能干扰的 compose 默认
    env.pop("WORKER_MCP_URL", None)

    worker_log = open("/tmp/worker-sdk-e2e.log", "w")
    worker = subprocess.Popen(
        ["node", "dist/index.js"],
        cwd=str(ROOT / "worker"),
        env=env,
        stdout=worker_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    print(f"worker pid={worker.pid}  日志: /tmp/worker-sdk-e2e.log")

    try:
        log(f"3. 等待 worker 注册（≤{REGISTER_WAIT_S}s）")
        deadline = time.time() + REGISTER_WAIT_S
        registered = False
        while time.time() < deadline:
            workers = events.registered_workers()
            if workers:
                registered = True
                for w in workers:
                    print(
                        f"  ✅ 已注册: {w['workerId']} "
                        f"version={w.get('opencodeVersion')} "
                        f"execPort={w.get('capabilities', {}).get('execPort')}"
                    )
                break
            if worker.poll() is not None:
                print(f"  ❌ worker 进程提前退出 code={worker.returncode}")
                print("----- worker 日志尾部 -----")
                print(Path("/tmp/worker-sdk-e2e.log").read_text()[-3000:])
                return 1
            time.sleep(1)
        if not registered:
            print("  ❌ 注册超时")
            print("----- worker 日志尾部 -----")
            print(Path("/tmp/worker-sdk-e2e.log").read_text()[-3000:])
            return 1

        # 稍等心跳/资源注入稳定
        time.sleep(2)

        log("4. WorkerClient 探测执行端点")
        client = WorkerClient(f"http://127.0.0.1:{EXEC_PORT}", token=TOKEN, timeout=10)
        agents = client.list_agents(str(work_dir))
        print(f"  list_agents -> {len(agents)} 个: {[a.get('name') for a in agents[:5]]}")

        todos = client.list_todos("ses_nonexistent", str(work_dir))
        print(f"  list_todos(不存在会话) -> {todos}（预期 [] 或降级）")

        log("5. execute_and_wait 提交真实任务")
        task_id = f"e2e-{int(time.time())}"
        print(f"task_id={task_id}")
        print(f"prompt=用一句话回答：1+1等于几？只输出答案。")

        t0 = time.time()
        try:
            result = execute_and_wait(
                client,
                events,
                prompt="用一句话回答：1+1等于几？只输出答案，不要解释。",
                task_id=task_id,
                timeout=EXEC_TIMEOUT_S,
                directory=str(work_dir / "task-e2e"),
                system="你是被第三方 SDK 调用的测试 agent，回答尽量简短。",
            )
        except TaskTimeoutError:
            print(f"  ❌ 等待超时（{EXEC_TIMEOUT_S}s）")
            print("已收事件:")
            for e in events.events_for(task_id=task_id) or events.events[-10:]:
                print(f"    {e['type']}: {e['payload']}")
            print("----- worker 日志尾部 -----")
            print(Path("/tmp/worker-sdk-e2e.log").read_text()[-4000:])
            return 1
        except ExecuteError as exc:
            print(f"  ❌ execute 失败: {exc} status={exc.status} body={exc.body}")
            return 1

        elapsed = time.time() - t0
        print(f"  ✅ 完成（{elapsed:.1f}s）")
        print(f"    task_id    : {result.task_id}")
        print(f"    session_id : {result.session_id}")
        print(f"    status     : {result.status}")
        print(f"    output     : {result.output}")
        print(f"    payload keys: {list(result.payload.keys())}")

        log("6. 验证事件流（session.updated / agent.status 等）")
        types = [e["type"] for e in events.events_for(task_id=task_id)]
        print(f"  该 task 相关事件类型序列: {types}")
        has_completed = "task.completed" in types
        print(f"  含 task.completed: {has_completed}")

        ok = bool(result.task_id == task_id and has_completed)
        print(f"\n{'✅ E2E PASS' if ok else '❌ E2E FAIL'}")
        return 0 if ok else 1

    finally:
        log("7. 清理：停 worker + EventsServer")
        if worker.poll() is None:
            try:
                os.killpg(os.getpgid(worker.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                worker.wait(timeout=10)
            except subprocess.TimeoutExpired:
                worker.kill()
        print(f"worker 退出码: {worker.returncode}")
        worker_log.close()
        events.stop()
        print("已停止 EventsServer")


if __name__ == "__main__":
    sys.exit(main())
