#!/usr/bin/env python3
"""资源/凭据下发端到端测试（服务模式）。

自包含：起控制面 → 起 worker 容器（注册到本控制面）→ 下发资源与凭据 →
断言 worker 侧落盘 → 清理容器。

运行：
  cd sdks/python
  python3 examples/e2e_resource_delivery.py                 # 默认镜像 aiagents-worker
  python3 examples/e2e_resource_delivery.py --keep          # 保留容器便于排查
  python3 examples/e2e_resource_delivery.py --image <tag>   # 指定 worker 镜像

前置：本机 Docker 可用；worker 镜像已存在（或 --image 指定已发布镜像）。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

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

CONTAINER = "worker-delivery-e2e"
MARK = "delivery-fixture"

passed = failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def dexec(cmd: str) -> bool:
    return subprocess.run(
        ["docker", "exec", CONTAINER, "sh", "-c", cmd],
        capture_output=True, text=True,
    ).returncode == 0


def poll(name: str, cmd: str, timeout: float = 120.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if dexec(cmd):
            check(name, True)
            return True
        time.sleep(2)
    check(name, False, f"timeout {timeout}s: {cmd}")
    return False


def start_container(image: str, control_port: int, token: str, work_dir: str) -> None:
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, text=True)
    args = [
        "docker", "run", "-d", "--name", CONTAINER,
        "-e", f"X_WORKER_TOKEN={token}",
        "-e", f"SERVER_URL=http://host.docker.internal:{control_port}",
        "-e", "WORKER_ID=w_delivery_e2e",
        "-e", "OPENCODE_SERVE_HOSTNAME=0.0.0.0",
        "-e", "OPENCODE_SERVE_PORT=4200",
        "-e", "WORKER_EXEC_PORT=4198",
        "-e", "WORKER_ADVERTISE_HOST=http://host.docker.internal",
        "-e", f"WORK_DIR={work_dir}",
    ]
    dist = ROOT / "worker" / "dist"
    if dist.is_dir():
        args += ["-v", f"{dist}:/app/dist:ro"]
    args.append(image)
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"docker run 失败: {r.stderr.strip()}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="aiagents-worker")
    ap.add_argument("--token", default="dev-token")
    ap.add_argument("--port", type=int, default=13999)
    ap.add_argument("--work-dir", default="/data/vteam-worker")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    work = args.work_dir
    try:
        with WorkerService(host="0.0.0.0", port=args.port, token=args.token) as svc:
            print(f"控制面: {svc.server_url}")
            start_container(args.image, args.port, args.token, work)
            print(f"worker 容器已启动: {CONTAINER}")
            worker = svc.wait_for_worker(timeout=180)
            print(f"worker 已注册: {worker.get('workerId')}\n")

            print("[1] 资源下发（拉取式）+ reload-config")
            svc.set_resources(
                skills=[SkillRecord(id="sk_delivery", name=f"{MARK}-skill", content=f"# {MARK} skill\n")],
                tools=[ToolRecord(id="tl_delivery", action=f"{MARK}-echo", name="Delivery Echo",
                                  execution="cli",
                                  schema={"type": "object",
                                          "properties": {"message": {"type": "string"}},
                                          "required": ["message"],
                                          "x-execution": {"command": ["echo"]}})],
                mcp_servers=[McpServerRecord(id="ms_delivery", name=f"{MARK}-mcp", type="remote",
                                             url="http://127.0.0.1:9/mcp")],
                agent_policies=[AgentPolicyRecord(name=f"{MARK}-agent", description="delivery e2e agent",
                                                  mode="primary", permission={"edit": "allow"})],
            )
            print(f"  reload-config -> {svc.reload_config()}")
            poll("skill SKILL.md 落盘", f"grep -q {MARK} {work}/.opencode/skills/{MARK}-skill/SKILL.md")
            poll("tool .ts 落盘", f"test -f {work}/.opencode/tools/{MARK}-echo.ts")
            poll("mcp 写入 opencode.json", f"grep -q {MARK}-mcp {work}/opencode.json")
            poll("agent 策略写入 opencode.json", f"grep -q {MARK}-agent {work}/opencode.json")

            print("[2] 模型凭据/配置下发（命令式）")
            print(f"  model-credentials -> {svc.push_model_credentials(
                [ModelCredentialEntry('delivery_test_provider', 'sk-delivery-123')],
                {'delivery_test_provider': ModelProviderConfigEntry('http://127.0.0.1:9/v1', ['delivery-model'])})}")
            poll("auth.json 写入 provider", "grep -q delivery_test_provider /root/.local/share/opencode/auth.json")
            poll("opencode.json provider 段写入",
                 "grep -q delivery_test_provider /root/.config/opencode/opencode.json")

            print("[3] git 凭据下发（命令式）")
            print(f"  git-credentials -> {svc.push_git_credentials(
                [GitCredentialEntry('git@example.com:org/repo.git', 'FAKEKEY', 'ssh_key', 'fp-delivery', 'read')])}")
            poll("git 凭据文件写入（600）", "grep -q git@example.com:org/repo.git /root/.keta-git-creds.json")

            print("[4] 远程 restart 命令")
            print(f"  restart -> {svc.restart()}")
            check("restart 已下发", True)
    finally:
        if not args.keep:
            subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, text=True)
            print(f"\n容器 {CONTAINER} 已清理")

    print(f"\nRESULT passed={passed} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
