#!/usr/bin/env python3
"""WorkerService 资源与凭据下发示例（服务模式）。

演示：资源 fixture（skills/tools/mcp-servers/agent-policies）+ reload-config +
模型凭据（model-credentials）+ git 凭据（git-credentials）下发。

前置：
1. 本脚本先起控制面（EventsServer），worker 的 SERVER_URL 指向它并完成注册：
     worker 侧: SERVER_URL=http://<本机>:13999  X_WORKER_TOKEN=dev-token
2. 本机 Python >= 3.10，无需安装第三方依赖。

运行：
  cd sdks/python
  python3 examples/resource_delivery.py

worker 侧落点：
  <WORK_DIR>/.opencode/skills/<name>/SKILL.md      ← skills
  <WORK_DIR>/.opencode/tools/<action>.ts            ← tools
  <WORK_DIR>/opencode.json（mcp / agent 节）         ← mcp-servers / agent-policies
  $HOME/.local/share/opencode/auth.json             ← model-credentials（providerKeys）
  $HOME/.config/opencode/opencode.json（provider）   ← model-credentials（providerConfigs）
  $HOME/.keta-git-creds.json                        ← git-credentials
"""

from __future__ import annotations

import sys

sys.path.insert(0, ".")

from worker_sdk import (  # noqa: E402
    AgentPolicyRecord,
    GitCredentialEntry,
    McpServerRecord,
    ModelCredentialEntry,
    ModelProviderConfigEntry,
    SkillRecord,
    ToolRecord,
    WorkerService,
)

TOKEN = "dev-token"
CONTROL_PORT = 13999


def main() -> None:
    with WorkerService(host="0.0.0.0", port=CONTROL_PORT, token=TOKEN) as svc:
        print(f"控制面: {svc.server_url}")
        worker = svc.wait_for_worker(timeout=120)
        print(f"worker 已注册: {worker.get('workerId')}")

        # 1) 资源下发（拉取式）：更新 fixture 后 reload-config 让 worker 重拉落盘
        svc.set_resources(
            skills=[SkillRecord(id="sk_demo", name="demo-skill", content="# demo skill\n")],
            tools=[
                ToolRecord(
                    id="tl_demo",
                    action="demo-echo",
                    name="Demo Echo",
                    execution="cli",
                    schema={
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                        "x-execution": {"command": ["echo"]},
                    },
                )
            ],
            mcp_servers=[
                McpServerRecord(id="ms_demo", name="demo-mcp", type="remote", url="http://127.0.0.1:9/mcp")
            ],
            agent_policies=[
                AgentPolicyRecord(name="demo-agent", description="demo agent policy",
                                  mode="primary", permission={"edit": "allow"})
            ],
        )
        print("reload-config ->", svc.reload_config())

        # 2) 模型凭据/配置下发（命令式）：worker 写 auth.json + opencode.json provider 段
        print(
            "model-credentials ->",
            svc.push_model_credentials(
                [ModelCredentialEntry("demo_provider", "sk-demo-123")],
                {"demo_provider": ModelProviderConfigEntry("http://127.0.0.1:9/v1", ["demo-model"])},
            ),
        )

        # 3) git 凭据下发（命令式）：worker 写 $HOME/.keta-git-creds.json（写盘即生效，不重启）
        print(
            "git-credentials ->",
            svc.push_git_credentials(
                [GitCredentialEntry("git@example.com:org/repo.git", "FAKEKEY", "ssh_key", "fp-demo", "read")]
            ),
        )

        # 4) 远程运维命令
        # svc.restart()      # 无活跃会话立即重启 serve
        # svc.shutdown()     # worker 优雅退出


if __name__ == "__main__":
    main()
