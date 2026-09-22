"""WorkerService：SDK 以服务形态模拟控制面，不依赖真实 vteam server。

职责：
- 内嵌启动 EventsServer（register / heartbeat / events / 资源拉取）
- 暴露 ``server_url`` 供 worker ``SERVER_URL`` 指向本服务
- 按注册 capabilities 自动发现 worker 执行端点（baseUrl + execPort）
- 包装 WorkerClient 与 execute_and_wait，第三方进程内一站式调用

启动顺序（硬约束）：本服务 → worker 注册 → 再 execute。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from .client import DEFAULT_EXEC_PORT, WorkerClient
from .events_server import EventsServer
from .exceptions import ServiceRequiredError, WorkerNotRegisteredError
from .models import ExecuteAccepted, TaskResult
from .waiter import execute_and_wait as _execute_and_wait


class WorkerService:
    """可嵌入的 worker 控制面服务（模拟 vteam server）。

    Args:
        host: EventsServer 监听地址（默认 0.0.0.0，便于容器内 worker 回连）。
        port: 控制面端口；0 = OS 随机（启动后读 :attr:`port`）。
        token: 与 worker ``X_WORKER_TOKEN`` 一致的共享 token。
        resources: 可选资源 fixture（skills/tools/mcp-servers/agent_policies）。
        worker_exec_url: 显式指定 worker 执行端点；缺省时按注册
            ``capabilities.baseUrl`` + ``execPort`` 自动发现。
        heartbeat_interval_ms / max_events / verbose: 透传 EventsServer。

    Usage::

        with WorkerService(port=13999, token="dev") as svc:
            # worker: SERVER_URL=<svc.server_url> X_WORKER_TOKEN=dev
            svc.wait_for_worker(timeout=60)
            result = svc.execute_and_wait("hello", task_id="t-1", timeout=120)
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 0,
        *,
        token: str,
        resources: dict[str, list[dict[str, Any]]] | None = None,
        worker_exec_url: str | None = None,
        heartbeat_interval_ms: int = 10_000,
        max_events: int = 2000,
        verbose: bool = True,
    ) -> None:
        self.token = token
        self._worker_exec_url = (
            WorkerClient._normalize_base(worker_exec_url) if worker_exec_url else None
        )
        self.events = EventsServer(
            host=host,
            port=port,
            token=token,
            heartbeat_interval_ms=heartbeat_interval_ms,
            max_events=max_events,
            verbose=verbose,
            resources=resources,
        )
        self._client: WorkerClient | None = None

    # -- lifecycle --------------------------------------------------------

    @property
    def port(self) -> int:
        return self.events.port

    @property
    def base_url(self) -> str:
        """EventsServer 对外基址（worker 应把 SERVER_URL 设为它）。"""
        return self.events.base_url

    @property
    def server_url(self) -> str:
        return self.events.base_url

    def start(self) -> "WorkerService":
        self.events.start()
        return self

    def stop(self) -> None:
        self.events.stop()
        self._client = None

    def __enter__(self) -> "WorkerService":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    # -- worker discovery -------------------------------------------------

    def registered_workers(self) -> list[dict[str, Any]]:
        return self.events.registered_workers()

    def wait_for_worker(self, timeout: float = 60.0) -> dict[str, Any]:
        """阻塞直到至少一台 worker 完成注册，返回其注册行。"""
        import time

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            workers = self.registered_workers()
            if workers:
                return workers[0]
            time.sleep(0.5)
        raise WorkerNotRegisteredError(
            f"等待 worker 注册超时（{timeout}s）；请确认 worker SERVER_URL={self.server_url}"
        )

    def resolve_exec_url(self, worker: dict[str, Any] | None = None) -> str:
        """解析 worker 执行端点 URL。

        优先级：构造参数 ``worker_exec_url`` > 注册 capabilities
        ``baseUrl`` 主机 + ``execPort`` > ``http://127.0.0.1:{execPort}``。
        """
        if self._worker_exec_url:
            return self._worker_exec_url
        w = worker or (self.registered_workers() or [None])[0]
        if not w:
            raise WorkerNotRegisteredError("尚无已注册 worker，无法发现执行端点")
        caps = w.get("capabilities") or {}
        exec_port = int(caps.get("execPort") or DEFAULT_EXEC_PORT)
        base = caps.get("baseUrl")
        if isinstance(base, str) and base.strip():
            parsed = urlparse(base if "://" in base else f"http://{base}")
            host = parsed.hostname or "127.0.0.1"
            scheme = parsed.scheme or "http"
            return f"{scheme}://{host}:{exec_port}"
        return f"http://127.0.0.1:{exec_port}"

    def client(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 30.0,
        refresh: bool = False,
    ) -> WorkerClient:
        """获取（或缓存）指向 worker 执行端点的 WorkerClient。"""
        if base_url:
            self._client = WorkerClient(base_url, token=self.token, timeout=timeout)
            return self._client
        if self._client is not None and not refresh:
            return self._client
        self._client = WorkerClient(
            self.resolve_exec_url(), token=self.token, timeout=timeout
        )
        return self._client

    # -- one-stop ---------------------------------------------------------

    def execute_and_wait(
        self,
        prompt: str | list[Any],
        *,
        task_id: str,
        timeout: float = 300.0,
        worker_url: str | None = None,
        **execute_kwargs: Any,
    ) -> TaskResult:
        """确保已注册 → 取 client → 提交并等待 ``task.completed``。"""
        worker = self.wait_for_worker(timeout=min(timeout, 60.0))
        client = self.client(worker_url) if worker_url else self.client()
        return _execute_and_wait(
            client,
            self.events,
            prompt,
            task_id=task_id,
            timeout=timeout,
            **execute_kwargs,
        )


class WorkerDirect:
    """客户端直连模式（非服务模式）：不启动内嵌控制面，直接连 worker 执行端点。

    适用 worker 以 ``WORKER_STANDALONE=true`` 独立启动（不注册/心跳）时，第三方服务
    只需提交/查询，无需 SDK 监听端口、无需 worker 注册。

    可用能力（透传 :class:`WorkerClient`，经 :attr:`client` 访问全部端点）：
    ``execute`` / ``question_reply`` / ``permission_reply`` / ``get_file`` /
    ``list_agents`` / ``list_todos`` / ``list_plan_files`` / ``write_plan_file`` /
    ``get_omo_config`` / ``set_omo_config`` / ``get_omo_agent_prompt`` / ``health``。

    限制：执行结果经 events 通道回流到控制面，直连模式无控制面，故无法等待结果——
    :meth:`execute_and_wait` 抛 :class:`ServiceRequiredError`。需要结果时改用
    :class:`WorkerService`（内嵌控制面）。

    Usage::

        with WorkerDirect("http://127.0.0.1:4198", token="dev-token") as worker:
            worker.execute("写一个 hello world", task_id="t-1", directory="/data/t-1")
            agents = worker.list_agents()
    """

    def __init__(
        self,
        worker_url: str,
        *,
        token: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._client = WorkerClient(worker_url, token=token, timeout=timeout)

    @property
    def client(self) -> WorkerClient:
        return self._client

    @property
    def base_url(self) -> str:
        return self._client.base_url

    def execute(self, prompt: str | list[Any], **kwargs: Any) -> ExecuteAccepted:
        """POST /execute（fire-and-forget，202 即返）；结果不经本响应返回。"""
        return self._client.execute(prompt, **kwargs)

    def health(self) -> bool:
        return self._client.health()

    def execute_and_wait(self, *args: Any, **kwargs: Any) -> TaskResult:
        """直连模式无控制面，无法等待结果；请改用 WorkerService。"""
        raise ServiceRequiredError(
            "直连模式（WorkerDirect）无内嵌控制面，无法等待执行结果；"
            "需要结果请改用 WorkerService（内嵌 EventsServer）或自行接收 events。"
        )

    def __enter__(self) -> "WorkerDirect":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def __getattr__(self, name: str) -> Any:
        """未显式定义的方法透传给底层 WorkerClient（get_file/list_agents/... 全端点）。"""
        client = self.__dict__.get("_client")
        if client is None:
            raise AttributeError(name)
        return getattr(client, name)


__all__ = ["WorkerService", "WorkerDirect"]
