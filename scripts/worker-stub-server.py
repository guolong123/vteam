#!/usr/bin/env python3
"""
vteam Worker Stub Server — 模拟 server 控制面最小实现（路线 A 桩服务器 Demo）

用途：
  让 worker 脱离真实 vteam server 独立部署。实现协议中 worker 启动硬依赖的
  3 个端点 + 资源拉取可选端点，第三方服务即可调用 worker 执行任务并从
  /api/v1/worker/events 收取执行结果。

协议依据：docs/agent-platform/34-Worker交互接口协议.md
  §2.1 注册  §2.2 心跳  §4 事件回流  §5 资源拉取（可选）

运行：
  python3 scripts/worker-stub-server.py --port 3000 --token change-me-worker-token

worker 侧配置：
  SERVER_URL=http://localhost:3000
  X_WORKER_TOKEN=change-me-worker-token

第三方调用执行：
  curl -X POST http://localhost:4198/execute \
    -H 'Content-Type: application/json' \
    -d '{"prompt":"hello","directory":"/tmp/work"}'
  # 结果异步回流：本服务 POST /api/v1/worker/events 的 task.completed 事件
"""

import argparse
import json
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# 内存状态
# ---------------------------------------------------------------------------

STATE_LOCK = threading.Lock()

# workerId -> 注册信息
WORKERS: Dict[str, Dict[str, Any]] = {}
# (workerId, eventId) 去重（协议 §4：server 按内存去重）
SEEN_EVENTS: set = set()
# 下行命令队列 workerId -> List[command]
COMMAND_QUEUES: Dict[str, List[Dict[str, Any]]] = {}
# 收到的事件日志（demo 用，方便观察结果）
EVENT_LOG: List[Dict[str, Any]] = []

TOKEN: str = "change-me-worker-token"
HEARTBEAT_INTERVAL_MS = 10_000
MAX_EVENT_LOG = 1000


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(msg: str) -> None:
    print(f"[{now_iso()}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "vteam-worker-stub/1.0"

    # -- 基础工具 -----------------------------------------------------------

    def _json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _send_json(self, status: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _check_token(self) -> bool:
        """协议 §1：共享 token 鉴权 x-worker-token。桩服务器做简单明文比对。"""
        token = self.headers.get("x-worker-token") or self.headers.get("X-Worker-Token")
        if token != TOKEN:
            self._send_json(401, {"code": "TOKEN_INVALID", "message": "invalid x-worker-token"})
            return False
        return True

    def log_message(self, fmt: str, *args: Any) -> None:
        # 静默默认访问日志（我们自己打关键日志）
        pass

    # -- 路由 ---------------------------------------------------------------

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/v1/workers/register":
            self._handle_register()
        elif path == "/api/v1/worker/events":
            self._handle_events()
        elif re.fullmatch(r"/api/v1/workers/[^/]+/heartbeat", path):
            worker_id = path.split("/")[4]
            self._handle_heartbeat(worker_id)
        elif path == "/api/v1/demo/push-command":
            self._handle_push_command()
        else:
            self._send_json(404, {"code": "NOT_FOUND", "path": path})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/v1/skills":
            self._handle_paged_list([])
        elif path == "/api/v1/tools":
            self._handle_paged_list([])
        elif path == "/api/v1/mcp-servers":
            self._handle_paged_list([])
        elif path == "/api/v1/agent-policies":
            self._send_json(200, {"agents": []})
        elif re.fullmatch(r"/api/v1/skills/[^/]+/content", path):
            self._send_json(200, {"content": ""})
        elif path == "/api/v1/demo/events":
            # demo 辅助：第三方轮询查看已收到的事件（结果）
            self._send_json(200, {"events": EVENT_LOG[-50:], "total": len(EVENT_LOG)})
        elif path == "/api/v1/demo/workers":
            with STATE_LOCK:
                self._send_json(200, {"workers": list(WORKERS.values())})
        else:
            self._send_json(404, {"code": "NOT_FOUND", "path": path})

    # -- 端点实现 -----------------------------------------------------------

    def _handle_register(self) -> None:
        """协议 §2.1 POST /api/v1/workers/register"""
        if not self._check_token():
            return
        body = self._json_body()
        worker_id = body.get("workerId")
        if not worker_id or not isinstance(worker_id, str):
            self._send_json(400, {"code": "BAD_REQUEST", "message": "workerId required"})
            return

        with STATE_LOCK:
            existing = WORKERS.get(worker_id)
            WORKERS[worker_id] = {
                "workerId": worker_id,
                "name": body.get("name"),
                "opencodeVersion": body.get("opencodeVersion"),
                "capabilities": body.get("capabilities", {}),
                "load": body.get("load", {"instances": 0}),
                "defaultModelId": body.get("defaultModelId"),
                "mcpUrl": body.get("mcpUrl"),
                "status": "online",
                "registeredAt": existing.get("registeredAt") if existing else now_iso(),
                "lastHeartbeatAt": now_iso(),
            }
            # 注册回放：协议 §2.1 无条件回放凭据——demo 无凭据，不入队命令
            # （真实 server 在此处 enqueue model-credentials / git-credentials）

        log(f"REGISTER worker={worker_id} version={body.get('opencodeVersion')} "
            f"maxInstances={body.get('capabilities', {}).get('maxInstances')}")

        self._send_json(200, {
            "workerId": worker_id,
            "heartbeatIntervalMs": HEARTBEAT_INTERVAL_MS,
            "serverTime": now_iso(),
        })

    def _handle_heartbeat(self, path_worker_id: str) -> None:
        """协议 §2.2 POST /api/v1/workers/:id/heartbeat"""
        if not self._check_token():
            return
        body = self._json_body()
        worker_id = body.get("workerId") or path_worker_id
        if worker_id != path_worker_id:
            self._send_json(400, {"code": "BAD_REQUEST", "message": "workerId mismatch"})
            return

        with STATE_LOCK:
            worker = WORKERS.get(worker_id)
            if worker is None:
                self._send_json(404, {"code": "WORKER_NOT_FOUND"})
                return
            worker["lastHeartbeatAt"] = now_iso()
            worker["load"] = body.get("load", worker.get("load"))
            worker["health"] = body.get("health", "ok")
            if body.get("mcpStatus"):
                worker["mcpStatus"] = body["mcpStatus"]
            # 取出并清空命令队列（协议 §3：命令一次有效）
            commands = COMMAND_QUEUES.pop(worker_id, [])

        resp: Dict[str, Any] = {
            "workerId": worker_id,
            "status": "online",
            "lastHeartbeatAt": now_iso(),
        }
        if commands:
            resp["commands"] = commands
            log(f"HEARTBEAT worker={worker_id} → 下发 {len(commands)} 条命令: "
                f"{[c.get('type') for c in commands]}")
        else:
            log(f"HEARTBEAT worker={worker_id} load={body.get('load')}")

        self._send_json(200, resp)

    def _handle_events(self) -> None:
        """协议 §4 POST /api/v1/worker/events → 恒 202"""
        if not self._check_token():
            return
        body = self._json_body()
        worker_id = body.get("workerId", "")
        event_id = body.get("eventId", "")
        event_type = body.get("type", "")

        with STATE_LOCK:
            if worker_id not in WORKERS:
                # 协议 §4：未注册 workerId → 404（防伪造注入）
                self._send_json(404, {"code": "WORKER_NOT_FOUND"})
                return
            dedup_key = (worker_id, event_id)
            if dedup_key in SEEN_EVENTS:
                # 协议 §4：内存去重，仍回 202
                self._send_json(202, {})
                return
            SEEN_EVENTS.add(dedup_key)

            record = {
                "receivedAt": now_iso(),
                "workerId": worker_id,
                "eventId": event_id,
                "type": event_type,
                "seq": body.get("seq"),
                "payload": body.get("payload", {}),
            }
            EVENT_LOG.append(record)
            if len(EVENT_LOG) > MAX_EVENT_LOG:
                del EVENT_LOG[: len(EVENT_LOG) - MAX_EVENT_LOG]

        # 重点事件打日志：task.completed = 执行结果
        if event_type == "task.completed":
            payload = body.get("payload", {})
            log(f"✅ TASK_COMPLETED worker={worker_id} task={payload.get('taskId')} "
                f"session={payload.get('sessionId')}")
            # 第三方在这里拿到最终结果（也可通过 GET /api/v1/demo/events 轮询）
            result_preview = json.dumps(payload, ensure_ascii=False)
            if len(result_preview) > 500:
                result_preview = result_preview[:500] + "..."
            log(f"   result: {result_preview}")
        elif event_type in ("session.question", "session.permission"):
            log(f"⚠️  {event_type} worker={worker_id} payload={json.dumps(body.get('payload', {}), ensure_ascii=False)[:300]}")
        elif event_type == "agent.status":
            status = body.get("payload", {}).get("status")
            log(f"   agent.status worker={worker_id} status={status}")
        # message.part.delta 太多，不逐条打（要看流式用 GET /api/v1/demo/events）

        self._send_json(202, {})

    def _handle_paged_list(self, items: List[Any]) -> None:
        """协议 §5 分页契约：{ items, total }；pageSize=100。"""
        if not self._check_token():
            return
        self._send_json(200, {"items": items, "total": len(items)})

    def _handle_push_command(self) -> None:
        """demo 辅助：第三方往某个 worker 的下一次心跳塞命令。

        curl -X POST localhost:3000/api/v1/demo/push-command \
          -H 'Content-Type: application/json' \
          -d '{"workerId":"w_xxx","type":"reload-config"}'
        """
        if not self._check_token():
            return
        body = self._json_body()
        worker_id = body.get("workerId")
        cmd_type = body.get("type", "reload-config")
        if not worker_id:
            self._send_json(400, {"code": "BAD_REQUEST", "message": "workerId required"})
            return
        cmd = {
            "type": cmd_type,
            "resourceVersion": now_iso(),
        }
        if "payload" in body:
            cmd["payload"] = body["payload"]
        with STATE_LOCK:
            COMMAND_QUEUES.setdefault(worker_id, []).append(cmd)
        log(f"PUSH_COMMAND worker={worker_id} type={cmd_type}")
        self._send_json(200, {"queued": True, "command": cmd})


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    global TOKEN, HEARTBEAT_INTERVAL_MS

    parser = argparse.ArgumentParser(description="vteam Worker Stub Server (路线 A demo)")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--port", type=int, default=3000, help="监听端口（默认 3000）")
    parser.add_argument("--token", default="change-me-worker-token",
                        help="共享鉴权 token，须与 worker 的 X_WORKER_TOKEN 一致")
    parser.add_argument("--heartbeat-interval-ms", type=int, default=10_000,
                        help="注册响应返回的心跳间隔（默认 10000）")
    args = parser.parse_args()

    TOKEN = args.token
    HEARTBEAT_INTERVAL_MS = args.heartbeat_interval_ms

    server = ThreadingHTTPServer((args.host, args.port), StubHandler)
    log(f"vteam worker stub server listening on {args.host}:{args.port}")
    log(f"token = {TOKEN}")
    log("")
    log("worker 侧配置：")
    log(f"  SERVER_URL=http://localhost:{args.port}")
    log(f"  X_WORKER_TOKEN={TOKEN}")
    log("")
    log("已实现端点：")
    log("  POST /api/v1/workers/register          # 注册（P0 必需）")
    log("  POST /api/v1/workers/:id/heartbeat     # 心跳 + 命令下发")
    log("  POST /api/v1/worker/events             # 事件回流（P0 结果通道）")
    log("  GET  /api/v1/skills|tools|mcp-servers  # 资源拉取（空列表）")
    log("  GET  /api/v1/agent-policies            # agent 策略（空）")
    log("")
    log("demo 辅助端点：")
    log("  GET  /api/v1/demo/events               # 轮询已收到的事件（含 task.completed）")
    log("  GET  /api/v1/demo/workers              # 已注册 worker 列表")
    log("  POST /api/v1/demo/push-command         # 手动塞下行命令")
    log("")
    log("等待 worker 连接... (Ctrl+C 退出)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutdown")
        server.shutdown()


if __name__ == "__main__":
    main()
