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


def as_payload(value: Any) -> Any:
    """dataclass → dict（调 to_payload）；其余类型原样返回（供嵌套字段统一序列化）。"""
    return value.to_payload() if hasattr(value, "to_payload") else value


@dataclass
class SkillRecord:
    """技能资源（GET /skills；content 供 GET /skills/:id/content）。"""

    id: str
    name: str | None = None
    content: str | None = None

    def to_payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id}
        if self.name is not None:
            out["name"] = self.name
        if self.content is not None:
            out["content"] = self.content
        return out


@dataclass
class ToolRecord:
    """自定义工具资源（GET /tools；需 execution + schema.x-execution 才会落盘注入）。"""

    id: str
    action: str
    name: str
    execution: str
    schema: dict[str, Any] | None = None
    enabled: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "name": self.name,
            "execution": self.execution,
            "schema": self.schema,
            "enabled": self.enabled,
        }


@dataclass
class McpServerRecord:
    """MCP 服务器资源（GET /mcp-servers；remote 用 url，local 用 command）。"""

    id: str
    name: str
    type: str
    url: str | None = None
    command: dict[str, Any] | None = None
    headers: dict[str, Any] | None = None
    oauth: dict[str, Any] | None = None
    enabled: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "command": self.command,
            "url": self.url,
            "headers": self.headers,
            "oauth": self.oauth,
            "enabled": self.enabled,
        }


@dataclass
class AgentPolicyRecord:
    """agent 策略资源（GET /agent-policies）。

    worker 侧校验（injector buildAgentDefinitions）：name 非空、description 必须为字符串、
    mode ∈ {'primary','all'}、permission 为对象且不得含 'write' 键（写闸门是 'edit'）。
    """

    name: str
    description: str
    mode: Literal["primary", "all"] = "primary"
    permission: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("AgentPolicyRecord.name 不能为空")
        if not isinstance(self.description, str) or not self.description:
            raise ValueError("AgentPolicyRecord.description 必须为非空字符串（worker 校验必需）")
        if self.mode not in ("primary", "all"):
            raise ValueError(
                f"AgentPolicyRecord.mode 仅支持 'primary' | 'all'，收到 {self.mode!r}"
            )
        if "write" in self.permission:
            raise ValueError("AgentPolicyRecord.permission 不得含 'write' 键（worker 写闸门是 'edit'）")

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "mode": self.mode,
            "permission": self.permission,
        }


@dataclass
class ModelCredentialEntry:
    """模型凭据条目（model-credentials 命令负载；worker 写入 auth.json）。"""

    provider_id: str
    key: str

    def to_payload(self) -> dict[str, Any]:
        return {"providerID": self.provider_id, "key": self.key}


@dataclass
class ProviderModelEntry:
    """provider 下的单模型条目（capabilities 为 opencode per-model 能力声明）。"""

    name: str | None = None
    capabilities: dict[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.name is not None:
            out["name"] = self.name
        if self.capabilities is not None:
            out["capabilities"] = self.capabilities
        return out


@dataclass
class ModelProviderConfigEntry:
    """provider 配置条目（model-credentials.providerConfigs；worker 写 opencode.json provider 段）。

    models 双形状：list[str]（仅模型 id）或 dict[str, ProviderModelEntry]（含 per-model 能力）。
    """

    base_url: str
    models: list[str] | dict[str, Any] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        if isinstance(self.models, dict):
            models: Any = {k: as_payload(v) for k, v in self.models.items()}
        else:
            models = list(self.models)
        return {"baseUrl": self.base_url, "models": models}


@dataclass
class GitCredentialEntry:
    """git 仓库凭据条目（git-credentials 命令负载；worker 写 .keta-git-creds.json）。"""

    repo_url: str
    key: str
    auth_type: Literal["ssh_key", "https_token"] = "ssh_key"
    fingerprint: str = ""
    permission: str | None = None

    def to_payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "repoUrl": self.repo_url,
            "authType": self.auth_type,
            "key": self.key,
            "fingerprint": self.fingerprint,
        }
        if self.permission is not None:
            out["permission"] = self.permission
        return out
