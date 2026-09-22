"""EventsServer：内嵌控制面，模拟 vteam server 的 register/heartbeat/events 三件套。

worker 配置 ``SERVER_URL`` 指向本服务后即可独立部署；执行结果经
``POST /api/v1/worker/events`` 流入内存，提供：

- ``events`` / ``events_for(task_id)``：查询已收事件
- ``wait_for_task(task_id, timeout)``：阻塞等待 ``task.completed``
- ``wait_for_event(predicate, timeout)``：通用谓词等待

同时实现资源拉取端点。默认返回空列表（injectAll 不报错）；构造时传
``resources={"skills": ..., "tools": ..., "mcp-servers": ..., "agent_policies": ...}``
可下发 fixture，用于 e2e 断言 worker 侧落盘（SKILL.md / tools/*.ts / opencode.json）。
"""

from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from .exceptions import TaskTimeoutError, TokenError, WorkerNotRegisteredError
from .models import TaskResult, WorkerEvent


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "worker-sdk-events/0.1"

    # 由 EventsServer 注入
    server: "ThreadingHTTPServer"  # type: ignore[assignment]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        owner: EventsServer = self.server.owner  # type: ignore[attr-defined]
        if owner.verbose:
            owner._log(f"http {self.command} {self.path} -> {fmt % args}")

    # -- helpers ----------------------------------------------------------

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _json(self, status: int, obj: Any) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _check_token(self) -> bool:
        owner: EventsServer = self.server.owner  # type: ignore[attr-defined]
        token = self.headers.get("x-worker-token") or self.headers.get("X-Worker-Token")
        if token != owner.token:
            self._json(401, {"code": "TOKEN_INVALID", "message": "invalid x-worker-token"})
            return False
        return True

    # -- routing ----------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        owner: EventsServer = self.server.owner  # type: ignore[attr-defined]

        if path == "/api/v1/workers/register":
            self._handle_register(owner)
        elif path == "/api/v1/worker/events":
            self._handle_events(owner)
        elif re.fullmatch(r"/api/v1/workers/[^/]+/heartbeat", path):
            self._handle_heartbeat(owner, path.split("/")[4])
        else:
            self._json(404, {"code": "NOT_FOUND", "path": path})

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        owner: EventsServer = self.server.owner  # type: ignore[attr-defined]

        if path in ("/api/v1/skills", "/api/v1/tools", "/api/v1/mcp-servers"):
            if not self._check_token():
                return
            kind = path.rsplit("/", 1)[-1]
            items = list(owner.resource_items(kind))
            self._json(
                200,
                {"items": items, "total": len(items), "page": 1, "pageSize": max(len(items), 1)},
            )
        elif path == "/api/v1/agent-policies":
            if not self._check_token():
                return
            agents = list(owner.resource_items("agent_policies"))
            self._json(200, {"agents": agents})
        elif m := re.fullmatch(r"/api/v1/skills/([^/]+)/content", path):
            if not self._check_token():
                return
            skill_id = m.group(1)
            content = owner.skill_content(skill_id)
            if content is None:
                self._json(404, {"code": "SKILL_NOT_FOUND", "id": skill_id})
            else:
                self._json(200, {"content": content})
        elif path == "/api/v1/demo/events":
            # 轮询便捷入口（与 stub server 对齐）
            if not self._check_token():
                return
            self._json(
                200,
                {
                    "events": [e.to_public() for e in owner.events[-owner.max_events:]],
                    "total": len(owner.events),
                },
            )
        elif path == "/api/v1/demo/workers":
            if not self._check_token():
                return
            with owner._lock:
                workers = list(owner.workers.values())
            self._json(200, {"workers": workers})
        else:
            self._json(404, {"code": "NOT_FOUND", "path": path})

    # -- endpoint impls ---------------------------------------------------

    def _handle_register(self, owner: "EventsServer") -> None:
        if not self._check_token():
            return
        body = self._body()
        worker_id = body.get("workerId")
        if not worker_id or not isinstance(worker_id, str):
            self._json(400, {"code": "BAD_REQUEST", "message": "workerId required"})
            return
        now = _now_iso()
        with owner._lock:
            prev = owner.workers.get(worker_id, {})
            owner.workers[worker_id] = {
                **prev,
                "workerId": worker_id,
                "name": body.get("name"),
                "opencodeVersion": body.get("opencodeVersion"),
                "capabilities": body.get("capabilities", {}),
                "load": body.get("load", {"instances": 0}),
                "status": "online",
                "registeredAt": prev.get("registeredAt", now),
                "lastHeartbeatAt": now,
            }
        owner._log(f"REGISTER worker={worker_id} version={body.get('opencodeVersion')}")
        self._json(
            200,
            {
                "workerId": worker_id,
                "heartbeatIntervalMs": owner.heartbeat_interval_ms,
                "serverTime": now,
            },
        )

    def _handle_heartbeat(self, owner: "EventsServer", path_worker_id: str) -> None:
        if not self._check_token():
            return
        body = self._body()
        worker_id = body.get("workerId") or path_worker_id
        if worker_id != path_worker_id:
            self._json(400, {"code": "BAD_REQUEST", "message": "workerId mismatch"})
            return
        with owner._lock:
            worker = owner.workers.get(worker_id)
            if worker is None:
                self._json(404, {"code": "WORKER_NOT_FOUND"})
                return
            worker["lastHeartbeatAt"] = _now_iso()
            worker["load"] = body.get("load", worker.get("load"))
            worker["health"] = body.get("health", "ok")
            commands = owner.command_queues.pop(worker_id, [])
        resp: dict[str, Any] = {
            "workerId": worker_id,
            "status": "online",
            "lastHeartbeatAt": _now_iso(),
        }
        if commands:
            resp["commands"] = commands
        self._json(200, resp)

    def _handle_events(self, owner: "EventsServer") -> None:
        if not self._check_token():
            return
        body = self._body()
        worker_id = body.get("workerId", "")
        event_id = body.get("eventId", "")

        with owner._lock:
            if worker_id not in owner.workers:
                self._json(404, {"code": "WORKER_NOT_FOUND"})
                return
            dedup_key = (worker_id, event_id)
            if dedup_key in owner._seen_events:
                self._empty(202)
                return
            owner._seen_events.add(dedup_key)

            event = _StoredEvent(
                worker_id=worker_id,
                event_id=event_id,
                type=body.get("type", ""),
                payload=body.get("payload", {}),
                seq=int(body.get("seq") or 0),
                received_at=_now_iso(),
            )
            owner.events.append(event)
            if len(owner.events) > owner.max_events:
                del owner.events[: len(owner.events) - owner.max_events]
            owner._cond.notify_all()

        if event.type == "task.completed":
            owner._log(
                f"TASK_COMPLETED worker={worker_id} task={event.payload.get('taskId')}"
            )
        self._empty(202)


class _StoredEvent:
    __slots__ = ("worker_id", "event_id", "type", "payload", "seq", "received_at")

    def __init__(
        self,
        worker_id: str,
        event_id: str,
        type: str,  # noqa: A002
        payload: dict[str, Any],
        seq: int,
        received_at: str,
    ) -> None:
        self.worker_id = worker_id
        self.event_id = event_id
        self.type = type
        self.payload = payload
        self.seq = seq
        self.received_at = received_at

    def to_public(self) -> dict[str, Any]:
        return {
            "receivedAt": self.received_at,
            "workerId": self.worker_id,
            "eventId": self.event_id,
            "type": self.type,
            "seq": self.seq,
            "payload": self.payload,
        }

    def to_task_result(self) -> TaskResult:
        p = self.payload
        return TaskResult(
            task_id=p.get("taskId"),
            session_id=p.get("sessionId"),
            status=p.get("status"),
            payload=p,
            worker_id=self.worker_id,
            event_id=self.event_id,
        )


class EventsServer:
    """内嵌控制面 HTTP 服务（threading）。

    Args:
        host: 监听地址（默认 0.0.0.0）。
        port: 监听端口；0 = OS 随机（启动后读 :attr:`port`）。
        token: 共享鉴权 token，须与 worker ``X_WORKER_TOKEN`` 一致。
        heartbeat_interval_ms: 注册响应返回的心跳间隔。
        verbose: 是否打印关键日志。
        resources: 资源 fixture（skills/tools/mcp-servers/agent_policies），
            非空时 worker injectAll 会落盘到 WORK_DIR。

    Usage::

        server = EventsServer(port=3000, token="secret")
        server.start()
        # worker: SERVER_URL=http://<host>:3000  X_WORKER_TOKEN=secret
        result = server.wait_for_task("t-1", timeout=120)
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 0,
        *,
        token: str,
        heartbeat_interval_ms: int = 10_000,
        max_events: int = 2000,
        verbose: bool = True,
        resources: dict[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        if not token:
            raise ValueError("token 必填（须与 worker X_WORKER_TOKEN 一致）")
        self.host = host
        self._requested_port = port
        self.token = token
        self.heartbeat_interval_ms = heartbeat_interval_ms
        self.max_events = max_events
        self.verbose = verbose
        # 资源 fixture：keys = skills | tools | mcp-servers | agent_policies
        # skills 条目含 content（供 /skills/:id/content）
        self._resources: dict[str, list[dict[str, Any]]] = {
            "skills": [],
            "tools": [],
            "mcp-servers": [],
            "agent_policies": [],
        }
        if resources:
            for k, v in resources.items():
                if k in self._resources and isinstance(v, list):
                    self._resources[k] = v

        self.workers: dict[str, dict[str, Any]] = {}
        self.command_queues: dict[str, list[dict[str, Any]]] = {}
        self.events: list[_StoredEvent] = []

        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._seen_events: set[tuple[str, str]] = set()
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle --------------------------------------------------------

    @property
    def port(self) -> int:
        if self._httpd is not None:
            return self._httpd.server_address[1]
        return self._requested_port

    @property
    def base_url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}"

    def start(self) -> "EventsServer":
        """后台线程启动 HTTP 服务；幂等。"""
        if self._httpd is not None:
            return self
        httpd = ThreadingHTTPServer((self.host, self._requested_port), _Handler)
        httpd.owner = self  # type: ignore[attr-defined]
        self._httpd = httpd
        self._thread = threading.Thread(
            target=httpd.serve_forever, name="worker-sdk-events", daemon=True
        )
        self._thread.start()
        self._log(f"EventsServer listening on {self.host}:{self.port}")
        self._log(f"  worker SERVER_URL={self.base_url}  X_WORKER_TOKEN={self.token}")
        return self

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> "EventsServer":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    # -- query / wait -----------------------------------------------------

    def events_for(self, task_id: str | None = None, *, type: str | None = None) -> list[dict[str, Any]]:  # noqa: A002
        """按 taskId / 事件类型过滤已收事件（公开 dict 形状）。"""
        with self._lock:
            out = []
            for e in self.events:
                if task_id is not None and e.payload.get("taskId") != task_id:
                    continue
                if type is not None and e.type != type:
                    continue
                out.append(e.to_public())
            return out

    def wait_for_task(self, task_id: str, timeout: float = 300.0) -> TaskResult:
        """阻塞等待指定 taskId 的 ``task.completed`` 事件。

        Raises:
            TaskTimeoutError: 超时未收到。
        """
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for e in self.events:
                    if e.type == "task.completed" and e.payload.get("taskId") == task_id:
                        return e.to_task_result()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TaskTimeoutError(task_id, timeout)
                self._cond.wait(timeout=remaining)

    def wait_for_event(
        self,
        predicate: Callable[[_StoredEvent], bool],
        timeout: float = 300.0,
    ) -> _StoredEvent:
        """按谓词阻塞等待任意事件。"""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for e in self.events:
                    if predicate(e):
                        return e
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TaskTimeoutError("<predicate>", timeout)
                self._cond.wait(timeout=remaining)

    def wait_for_session_completed(
        self, session_id: str, timeout: float = 300.0
    ) -> TaskResult:
        """按 opencode sessionId 等待 task.completed。"""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for e in self.events:
                    if (
                        e.type == "task.completed"
                        and e.payload.get("sessionId") == session_id
                    ):
                        return e.to_task_result()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TaskTimeoutError(f"session={session_id}", timeout)
                self._cond.wait(timeout=remaining)

    # -- command queue (optional) ----------------------------------------

    def push_command(self, worker_id: str, command: dict[str, Any]) -> None:
        """往 worker 下一次心跳塞下行命令（如 reload-config）。"""
        cmd = dict(command)
        cmd.setdefault("resourceVersion", _now_iso())
        with self._lock:
            self.command_queues.setdefault(worker_id, []).append(cmd)

    def registered_workers(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.workers.values())

    def resource_items(self, kind: str) -> list[dict[str, Any]]:
        """返回资源 fixture 列表（skills/tools/mcp-servers/agent_policies）。"""
        return list(self._resources.get(kind, []))

    def skill_content(self, skill_id: str) -> str | None:
        for s in self._resources.get("skills", []):
            if s.get("id") == skill_id:
                return s.get("content")
        return None

    def _log(self, msg: str) -> None:
        print(f"[{_now_iso()}] {msg}", flush=True)
