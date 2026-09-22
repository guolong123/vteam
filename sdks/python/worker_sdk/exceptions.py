"""SDK 异常类型。"""

from __future__ import annotations


class WorkerError(Exception):
    """worker SDK 所有异常的基类。"""

    def __init__(self, message: str, status: int | None = None, body: object = None):
        super().__init__(message)
        self.status = status
        self.body = body


class ExecuteError(WorkerError):
    """POST /execute 等执行端点返回非 2xx。"""


class TokenError(WorkerError):
    """X-Worker-Token 缺失或不匹配（401）。"""


class WorkerNotRegisteredError(WorkerError):
    """worker 未注册到控制面（404 WORKER_NOT_FOUND）。"""


class ServiceRequiredError(WorkerError):
    """该能力需要控制面（内嵌 EventsServer / WorkerService），直连模式不可用。"""


class QuestionExpiredError(WorkerError):
    """question/permission requestId 已失效（404 QUESTION_EXPIRED）。"""

    def __init__(self, message: str, status: int = 404, body: object = None):
        super().__init__(message, status=status, body=body)


class TaskTimeoutError(WorkerError):
    """等待执行结果超时。"""

    def __init__(self, task_id: str, timeout: float):
        super().__init__(f"等待任务 {task_id} 结果超时（{timeout}s）")
        self.task_id = task_id
        self.timeout = timeout
