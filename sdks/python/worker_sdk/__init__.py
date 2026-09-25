"""vteam Worker Python SDK — 第三方调用 worker 执行端点 + 接收执行结果。

组成：
- WorkerClient：调用 worker 执行端点（/execute、/question-reply 等 10 个端点）
- EventsServer：内嵌控制面（register/heartbeat/events 三件套），worker 指向它即可
  独立部署；执行结果从 events 通道流入，提供 wait_for_task 阻塞等待
- WorkerService：服务形态封装（start/stop + 发现 worker + execute_and_wait），
  也可用 ``python -m worker_sdk`` 独立拉起
- execute_and_wait：一站式 提交 + 等待结果

零第三方依赖，仅用标准库。
"""

from .client import WorkerClient
from .events_server import EventsServer, WorkerEvent
from .exceptions import (
    ExecuteError,
    QuestionExpiredError,
    ServiceRequiredError,
    TokenError,
    WorkerError,
    WorkerNotRegisteredError,
)
from .models import (
    AgentPolicyRecord,
    ExecuteAccepted,
    ExecutionConfig,
    GitCredentialEntry,
    McpServerRecord,
    ModelCredentialEntry,
    ModelProviderConfigEntry,
    ModelRef,
    ProviderModelEntry,
    QuestionReply,
    PermissionReply,
    SkillRecord,
    TaskResult,
    ToolRecord,
)
from .service import WorkerDirect, WorkerService
from .waiter import execute_and_wait

__all__ = [
    "WorkerClient",
    "EventsServer",
    "WorkerService",
    "WorkerDirect",
    "WorkerEvent",
    "execute_and_wait",
    "ExecuteAccepted",
    "ExecutionConfig",
    "ModelRef",
    "QuestionReply",
    "PermissionReply",
    "TaskResult",
    "SkillRecord",
    "ToolRecord",
    "McpServerRecord",
    "AgentPolicyRecord",
    "ModelCredentialEntry",
    "ProviderModelEntry",
    "ModelProviderConfigEntry",
    "GitCredentialEntry",
    "WorkerError",
    "ExecuteError",
    "TokenError",
    "WorkerNotRegisteredError",
    "QuestionExpiredError",
    "ServiceRequiredError",
]

__version__ = "0.1.0"
