"""一站式 提交执行 + 等待结果。"""

from __future__ import annotations

from typing import Any

from .client import WorkerClient
from .events_server import EventsServer
from .models import (
    ExecuteAttachment,
    ExecutionConfig,
    ModelRef,
    TaskResult,
)


def execute_and_wait(
    client: WorkerClient,
    events: EventsServer,
    prompt: str | list[Any],
    *,
    task_id: str,
    timeout: float = 300.0,
    **execute_kwargs: Any,
) -> TaskResult:
    """提交 /execute 并阻塞等待对应 ``task.completed``。

    Args:
        client: 已配置好的 WorkerClient（指向 worker exec 端点）。
        events: 已启动的 EventsServer（worker 的 SERVER_URL 须指向它）。
        prompt: 执行提示。
        task_id: 业务任务 id；结果按 ``payload.taskId == task_id`` 匹配。
        timeout: 等待秒数。
        **execute_kwargs: 透传 :meth:`WorkerClient.execute`（model/agent/directory/...）。

    Returns:
        TaskResult：task.completed 事件聚合视图。

    Raises:
        TaskTimeoutError: 超时。
        ExecuteError: /execute 返回非 2xx。
    """
    client.execute(prompt, task_id=task_id, **execute_kwargs)
    return events.wait_for_task(task_id, timeout=timeout)


__all__ = ["execute_and_wait"]
