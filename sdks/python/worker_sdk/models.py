"""协议数据模型（对齐 worker/src/exec/exec-server.ts 与 worker-protocol.ts）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class ModelRef:
    """模型引用（opencode serve 格式）。"""

    provider_id: str
    model_id: str

    def to_payload(self) -> dict[str, str]:
        return {"providerID": self.provider_id, "modelID": self.model_id}


@dataclass
class ExecutionConfig:
    """执行策略（权限矩阵 + 可写路径）。"""

    permissions: dict[str, Literal["allow", "ask", "deny"]] = field(default_factory=dict)
    write_paths: list[str] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return {"permissions": self.permissions, "writePaths": self.write_paths}


@dataclass
class ExecuteAttachment:
    """图片附件引用（worker 按需下载）。"""

    url: str
    mime: str | None = None
    filename: str | None = None

    def to_payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {"url": self.url}
        if self.mime is not None:
            out["mime"] = self.mime
        if self.filename is not None:
            out["filename"] = self.filename
        return out


@dataclass
class ExecuteAccepted:
    """POST /execute 202 响应。"""

    accepted: bool
    status: int


@dataclass
class QuestionReply:
    """模型 question 回复。"""

    session_id: str
    request_id: str
    answers: list[list[str]] | None = None
    reject: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "requestId": self.request_id,
            "answers": None if self.reject else (self.answers or []),
            **({"reject": True} if self.reject else {}),
        }


@dataclass
class PermissionReply:
    """工具权限确认回复。"""

    session_id: str
    permission_id: str
    response: Literal["once", "always", "reject"]

    def to_payload(self) -> dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "permissionId": self.permission_id,
            "response": self.response,
        }


@dataclass
class WorkerEvent:
    """POST /api/v1/worker/events 请求体（协议 §4）。"""

    worker_id: str
    event_id: str
    type: str
    payload: dict[str, Any]
    seq: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "workerId": self.worker_id,
            "eventId": self.event_id,
            "type": self.type,
            "payload": self.payload,
            "seq": self.seq,
        }


@dataclass
class TaskResult:
    """task.completed 事件的聚合视图。"""

    task_id: str | None
    session_id: str | None
    status: str | None
    payload: dict[str, Any]
    worker_id: str
    event_id: str

    @property
    def output(self) -> Any:
        """便捷字段：尝试从常见结果字段中取出输出文本。"""
        p = self.payload
        for key in ("output", "result", "text", "content", "message"):
            if key in p:
                return p[key]
        return None
