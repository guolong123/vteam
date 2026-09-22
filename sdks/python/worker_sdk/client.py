"""WorkerClient：调用 worker 执行端点（协议 §6，execPort 默认 4198）。

鉴权：除 POST /execute 外，写路径均要求 X-Worker-Token（与 worker 配置的
X_WORKER_TOKEN 一致）。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable

from .exceptions import ExecuteError, QuestionExpiredError, TokenError, WorkerError
from .models import (
    ExecuteAccepted,
    ExecuteAttachment,
    ExecutionConfig,
    ModelRef,
    PermissionReply,
    QuestionReply,
)

DEFAULT_EXEC_PORT = 4198


class WorkerClient:
    """worker 执行端点 HTTP 客户端。

    Args:
        base_url: worker 执行端点基址，如 ``http://10.0.0.5:4198``
            （可只传 host，自动补 http:// 与默认端口）。
        token: X-Worker-Token；与 worker 环境变量 ``X_WORKER_TOKEN`` 一致。
            未配置 worker token 时可传 None（但 /execute 之外的端点会 401）。
        timeout: 单次 HTTP 请求超时秒数（默认 30s；/execute 是 202 即返，不受执行时长影响）。
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        *,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = self._normalize_base(base_url)
        self.token = token
        self.timeout = timeout

    @staticmethod
    def _normalize_base(base_url: str) -> str:
        raw = base_url.strip().rstrip("/")
        if not raw:
            raise ValueError("base_url 不能为空")
        if not raw.startswith(("http://", "https://")):
            # 允许传 "host" 或 "host:4198"
            raw = f"http://{raw}"
            if ":" not in raw.rsplit("/", 1)[-1]:
                raw = f"{raw}:{DEFAULT_EXEC_PORT}"
        return raw

    # ------------------------------------------------------------------
    # 底层请求
    # ------------------------------------------------------------------

    def _headers(self, *, auth: bool = True) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if auth:
            if not self.token:
                raise TokenError("该端点需要 X-Worker-Token，但 client 未配置 token")
            headers["X-Worker-Token"] = self.token
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
        auth: bool = True,
        expect: Iterable[int] = (200,),
        raw_response: bool = False,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers(auth=auth))
        expect_set = set(expect)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                content = resp.read()
                if raw_response:
                    return status, content
                if status not in expect_set:
                    raise ExecuteError(f"意外状态码 {status}", status=status, body=content)
                if not content:
                    return None
                try:
                    return json.loads(content)
                except json.JSONDecodeError:
                    return content
        except urllib.error.HTTPError as exc:
            err_body: Any
            raw = exc.read()
            try:
                err_body = json.loads(raw)
            except json.JSONDecodeError:
                err_body = raw
            message = ""
            code = ""
            if isinstance(err_body, dict):
                message = str(err_body.get("error") or err_body.get("message") or "")
                code = str(err_body.get("code") or "")
            if exc.code == 401:
                raise TokenError(message or "X-Worker-Token 无效", status=401, body=err_body) from exc
            if exc.code == 404 and code == "QUESTION_EXPIRED":
                raise QuestionExpiredError(
                    message or "question/permission 已失效", status=404, body=err_body
                ) from exc
            raise ExecuteError(
                message or f"HTTP {exc.code}", status=exc.code, body=err_body
            ) from exc
        except urllib.error.URLError as exc:
            raise ExecuteError(f"无法连接 worker {self.base_url}: {exc.reason}") from exc
        except OSError as exc:
            raise ExecuteError(f"请求 worker 网络异常 {self.base_url}: {exc}") from exc

    # ------------------------------------------------------------------
    # 执行端点（协议 §6）
    # ------------------------------------------------------------------

    def execute(
        self,
        prompt: str | list[Any],
        *,
        model: ModelRef | dict[str, str] | None = None,
        agent: str | None = None,
        directory: str | None = None,
        system: str | None = None,
        task_id: str | None = None,
        agent_id: str | None = None,
        channel_id: str | None = None,
        session_id: str | None = None,
        execution_config: ExecutionConfig | dict[str, Any] | None = None,
        attachments: list[ExecuteAttachment] | list[dict[str, Any]] | None = None,
    ) -> ExecuteAccepted:
        """POST /execute：提交执行任务（fire-and-forget，202 即返）。

        执行结果不经本响应返回——通过 EventsServer 的 events 通道异步收取
        （``task.completed``），或用 :func:`worker_sdk.execute_and_wait`。

        Args:
            prompt: 字符串或 serve parts 数组。
            model: 模型选择；缺省 serve 默认模型。
            agent: opencode agent 名。
            directory: 工作目录（worker 会确保其存在）。
            system: 顶层 system 提示。
            task_id: 业务任务 id（透传到事件，用于关联结果）。
            agent_id / channel_id: 业务透传字段。
            session_id: 复用已有 opencode 会话；缺省新建。
            execution_config: 权限矩阵与可写路径。
            attachments: 图片附件引用。
        """
        payload: dict[str, Any] = {"prompt": prompt}
        if model is not None:
            payload["model"] = (
                model.to_payload() if isinstance(model, ModelRef) else model
            )
        if agent is not None:
            payload["agent"] = agent
        if directory is not None:
            payload["directory"] = directory
        if system is not None:
            payload["system"] = system
        if task_id is not None:
            payload["taskId"] = task_id
        if agent_id is not None:
            payload["agentId"] = agent_id
        if channel_id is not None:
            payload["channelId"] = channel_id
        if session_id is not None:
            payload["sessionId"] = session_id
        if execution_config is not None:
            payload["executionConfig"] = (
                execution_config.to_payload()
                if isinstance(execution_config, ExecutionConfig)
                else execution_config
            )
        if attachments:
            payload["attachments"] = [
                a.to_payload() if isinstance(a, ExecuteAttachment) else a
                for a in attachments
            ]

        # /execute 无鉴权（协议 §6：fire-and-forget）
        resp = self._request(
            "POST", "/execute", body=payload, auth=False, expect=(202,)
        )
        accepted = bool(isinstance(resp, dict) and resp.get("accepted", True))
        return ExecuteAccepted(accepted=accepted, status=202)

    def question_reply(self, reply: QuestionReply | dict[str, Any]) -> dict[str, Any]:
        """POST /question-reply：回复模型 question。

        也可直接传 dict 形状 ``{sessionId, requestId, answers|reject}``。
        """
        payload = reply.to_payload() if isinstance(reply, QuestionReply) else reply
        return self._request("POST", "/question-reply", body=payload, expect=(200,))

    def permission_reply(self, reply: PermissionReply | dict[str, Any]) -> dict[str, Any]:
        """POST /question-reply：回复工具权限确认（permission 分支）。"""
        payload = reply.to_payload() if isinstance(reply, PermissionReply) else reply
        return self._request("POST", "/question-reply", body=payload, expect=(200,))

    def get_file(self, path: str) -> bytes:
        """GET /file?path=<abs>：拉取 worker 工作区文件（二进制安全，≤10MB）。"""
        _, content = self._request(
            "GET", "/file", query={"path": path}, expect=(200,), raw_response=True
        )
        return content

    def list_agents(self, directory: str | None = None) -> list[dict[str, Any]]:
        """GET /agents：列出 opencode 原生 agent；失败降级返回 []。"""
        query = {"directory": directory} if directory else None
        try:
            resp = self._request("GET", "/agents", query=query, expect=(200,))
        except (TokenError, ExecuteError):
            return []
        if isinstance(resp, dict):
            return list(resp.get("agents") or [])
        return []

    def list_todos(self, session_id: str, directory: str | None = None) -> list[dict[str, Any]]:
        """GET /todos：会话 todo 步骤；失败降级返回 []。"""
        query: dict[str, str] = {"sessionId": session_id}
        if directory:
            query["directory"] = directory
        try:
            resp = self._request("GET", "/todos", query=query, expect=(200,))
        except (TokenError, ExecuteError):
            return []
        if isinstance(resp, dict):
            return list(resp.get("todos") or [])
        return []

    def list_plan_files(self, directory: str | None = None) -> list[dict[str, Any]]:
        """GET /plan-files：任务目录 .omo/plans 与 .opencode/plans 的 *.md 列表。"""
        query = {"directory": directory} if directory else None
        try:
            resp = self._request("GET", "/plan-files", query=query, expect=(200,))
        except (TokenError, ExecuteError):
            return []
        if isinstance(resp, dict):
            return list(resp.get("files") or [])
        return []

    def write_plan_file(
        self, name: str, content: str, directory: str | None = None
    ) -> dict[str, Any]:
        """POST /plan-file：写入计划文件（name 须为纯 *.md 文件名）。"""
        body: dict[str, Any] = {"name": name, "content": content}
        if directory is not None:
            body["directory"] = directory
        return self._request("POST", "/plan-file", body=body, expect=(200,))

    def get_omo_config(self) -> dict[str, Any]:
        """GET /omo-config：读取 OmO agent→模型配置。"""
        resp = self._request("GET", "/omo-config", expect=(200,))
        return resp if isinstance(resp, dict) else {}

    def set_omo_config(
        self,
        agents: dict[str, str] | None = None,
        *,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        """POST /omo-config：增量合并 agent→模型映射；enabled 控制 OmO 开关。

        agents 值为空串表示清除该 agent 的覆盖。
        """
        body: dict[str, Any] = {}
        if agents is not None:
            body["agents"] = agents
        if enabled is not None:
            body["enabled"] = enabled
        if not body:
            raise ValueError("agents 与 enabled 至少提供一个")
        resp = self._request("POST", "/omo-config", body=body, expect=(200,))
        return resp if isinstance(resp, dict) else {}

    def get_omo_agent_prompt(self, name: str) -> dict[str, Any]:
        """GET /omo-agent-prompt?name=：取单 agent 系统提示词全文。"""
        resp = self._request(
            "GET", "/omo-agent-prompt", query={"name": name}, expect=(200,)
        )
        return resp if isinstance(resp, dict) else {}

    def health(self) -> bool:
        """探测 worker 执行端点是否可达（GET 任意路径收到 HTTP 响应即视为活着）。"""
        try:
            self._request("GET", "/__health__", auth=False, expect=range(200, 600))
            return True
        except WorkerError as exc:
            # 收到 HTTP 响应（含 404 等）即视为存活；连接失败（无 status）才算不可达
            return getattr(exc, "status", None) is not None
        except Exception:
            return False
