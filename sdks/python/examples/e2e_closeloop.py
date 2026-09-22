#!/usr/bin/env python3
"""方案1闭环：临时把 compose worker 的 SERVER_URL 切到本地 EventsServer，
execute_and_wait 收 task.completed，结束后恢复 compose 并重建 worker。

前置：Docker 已跑 aiagents-compose-{server,worker}，.env 中 WORKER_TOKEN 一致。
中断说明：会 recreate worker 容器，原在途任务丢失（卷数据保留）。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# examples/ -> python/ -> sdks/ -> repo root
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from worker_sdk import EventsServer, WorkerClient, execute_and_wait  # noqa: E402
from worker_sdk.exceptions import ExecuteError, TaskTimeoutError  # noqa: E402

TOKEN = "compose-worker-token"
CONTROL_PORT = 13999
EXEC_TIMEOUT_S = 180
REGISTER_WAIT_S = 90
DISK_WAIT_S = 30
WORK_DIR = "/data/vteam-worker"
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_BAK = ROOT / "docker-compose.yml.e2e-bak"
WORKER_NAME = "aiagents-compose-worker"

# 资源 fixture：对齐 injector.ts SkillRecord/ToolRecord/McpServerRecord/AgentPolicyDefinition
# tool 需 execution + schema.x-execution 才会落盘；agent permission 禁止 write 键
RESOURCES = {
    "skills": [
        {
            "id": "sk_e2e_fixture",
            "name": "e2e-fixture-skill",
            "content": (
                "---\n"
                "name: e2e-fixture-skill\ndescription: E2E fixture skill for EventsServer\n"
                "---\n\n# E2E Fixture\n\nInjected by EventsServer resource fixtures.\n"
            ),
        }
    ],
    "tools": [
        {
            "id": "tl_e2e_fixture",
            "action": "e2e-fixture-echo",
            "name": "E2E Fixture Echo",
            "execution": "cli",
            "enabled": True,
            "schema": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "text to echo"},
                },
                "required": ["message"],
                "x-execution": {"command": ["echo"]},
            },
        }
    ],
    "mcp-servers": [
        {
            "id": "ms_e2e_fixture",
            "name": "e2e-fixture-mcp",
            "type": "remote",
            "command": None,
            "url": "http://127.0.0.1:9/mcp",
            "headers": None,
            "oauth": None,
            "enabled": True,
        }
    ],
    "agent_policies": [
        {
            "name": "e2e-fixture-agent",
            "description": "E2E fixture agent policy",
            "mode": "primary",
            "permission": {"edit": "allow"},
        }
    ],
}

passed = failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name} {detail}")


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def gateway_ip() -> str:
    out = sh(
        [
            "docker",
            "exec",
            WORKER_NAME,
            "sh",
            "-c",
            "getent hosts host.docker.internal | awk '{print $1; exit}'",
        ]
    )
    return out.stdout.strip() or "host.docker.internal"


def worker_ip() -> str:
    out = sh(
        [
            "docker",
            "inspect",
            "-f",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
            WORKER_NAME,
        ]
    )
    return out.stdout.strip()


def patch_compose(server_url: str) -> None:
    if not COMPOSE_BAK.exists():
        shutil.copy2(COMPOSE, COMPOSE_BAK)
        print(f"  备份 -> {COMPOSE_BAK.name}")
    text = COMPOSE.read_text()
    # 只替换 worker 段内的 SERVER_URL（当前唯一硬编码 http://server:3000）
    new_text, n = re.subn(
        r"(worker:.*?SERVER_URL:\s*)http://server:3000",
        rf"\g<1>{server_url}",
        text,
        count=1,
        flags=re.S,
    )
    if n != 1:
        raise RuntimeError(f"SERVER_URL 替换失败 n={n}")
    COMPOSE.write_text(new_text)
    print(f"  SERVER_URL -> {server_url}")


def restore_compose() -> None:
    if COMPOSE_BAK.exists():
        shutil.copy2(COMPOSE_BAK, COMPOSE)
        COMPOSE_BAK.unlink()
        print("  已还原 docker-compose.yml")
    else:
        # 兜底硬替换
        text = COMPOSE.read_text()
        text = re.sub(
            r"(worker:.*?SERVER_URL:\s*)\S+",
            r"\g<1>http://server:3000",
            text,
            count=1,
            flags=re.S,
        )
        COMPOSE.write_text(text)
        print("  硬还原 SERVER_URL=http://server:3000")


def recreate_worker() -> int:
    r = sh(["docker", "compose", "up", "-d", "--force-recreate", "worker"], cwd=str(ROOT))
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
    return r.returncode


def wait_registered(events: EventsServer, timeout_s: float) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        workers = events.registered_workers()
        if workers:
            for w in workers:
                print(
                    f"  ✅ 注册: {w['workerId']} "
                    f"execPort={w.get('capabilities', {}).get('execPort')}"
                )
            return True
        time.sleep(1)
    print("  ❌ 注册超时")
    return False


def docker_read(path: str) -> str | None:
    r = sh(["docker", "exec", WORKER_NAME, "cat", path])
    return r.stdout if r.returncode == 0 else None


def wait_disk(paths: list[str], timeout_s: float) -> bool:
    deadline = time.time() + timeout_s
    pending = set(paths)
    while pending and time.time() < deadline:
        for p in list(pending):
            if docker_read(p) is not None:
                pending.discard(p)
        if pending:
            time.sleep(1)
    if pending:
        print(f"  ❌ 落盘超时: {sorted(pending)}")
        return False
    return True


def assert_resource_injection() -> None:
    skill_path = f"{WORK_DIR}/.opencode/skills/e2e-fixture-skill/SKILL.md"
    tool_path = f"{WORK_DIR}/.opencode/tools/e2e-fixture-echo.ts"
    cfg_path = f"{WORK_DIR}/opencode.json"
    manifest_path = f"{WORK_DIR}/.opencode-worker-inject.json"
    ok = wait_disk([skill_path, tool_path, cfg_path, manifest_path], DISK_WAIT_S)
    check("资源文件落盘（skills/tools/opencode.json/manifest）", ok)

    skill = docker_read(skill_path) or ""
    check("SKILL.md 含 fixture 标记", "E2E Fixture" in skill, repr(skill[:80]))

    tool = docker_read(tool_path) or ""
    check(
        "tools/*.ts 含 description+cli execute",
        "E2E Fixture Echo" in tool and "spawnSync" in tool and '"echo"' in tool,
        repr(tool[:120]),
    )

    cfg_raw = docker_read(cfg_path)
    try:
        cfg = json.loads(cfg_raw) if cfg_raw else {}
    except json.JSONDecodeError:
        cfg = {}
    mcp = cfg.get("mcp") if isinstance(cfg.get("mcp"), dict) else {}
    check("opencode.json mcp 含 fixture", "e2e-fixture-mcp" in mcp, str(list(mcp)[:8]))
    check(
        "mcp entry type=remote/url",
        isinstance(mcp.get("e2e-fixture-mcp"), dict)
        and mcp["e2e-fixture-mcp"].get("type") == "remote"
        and bool(mcp["e2e-fixture-mcp"].get("url")),
        str(mcp.get("e2e-fixture-mcp")),
    )
    agents = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    check("opencode.json agent 含 fixture", "e2e-fixture-agent" in agents, str(list(agents)[:8]))
    if "e2e-fixture-agent" in agents:
        entry = agents["e2e-fixture-agent"] or {}
        check(
            "agent entry mode=primary",
            entry.get("mode") == "primary" and "permission" in entry,
            str(entry),
        )

    man_raw = docker_read(manifest_path)
    try:
        man = json.loads(man_raw) if man_raw else {}
    except json.JSONDecodeError:
        man = {}
    check(
        "manifest 记录 skills/tools/mcp",
        "e2e-fixture-skill" in (man.get("skills") or [])
        and "e2e-fixture-echo.ts" in (man.get("tools") or [])
        and "e2e-fixture-mcp" in (man.get("mcpServers") or []),
        str({k: man.get(k) for k in ("skills", "tools", "mcpServers", "agentNames")}),
    )
    check(
        "manifest 记录 agentNames",
        "e2e-fixture-agent" in (man.get("agentNames") or []),
        str(man.get("agentNames")),
    )


def main() -> int:
    print("=" * 60)
    print("方案1：临时切 SERVER_URL → EventsServer 收 task.completed")
    print("=" * 60)

    gw = gateway_ip()
    check("获取容器网关", bool(gw), gw)
    server_url = f"http://{gw}:{CONTROL_PORT}"
    print(f"  worker 将连: {server_url}")

    print("\n1. 启动 EventsServer (0.0.0.0) + 资源 fixture")
    events = EventsServer(
        host="0.0.0.0",
        port=CONTROL_PORT,
        token=TOKEN,
        verbose=True,
        resources=RESOURCES,
    )
    events.start()
    check("EventsServer 启动", events.port == CONTROL_PORT, f"port={events.port}")
    check(
        "fixture 四类资源就绪",
        all(
            len(events.resource_items(k)) == 1
            for k in ("skills", "tools", "mcp-servers", "agent_policies")
        ),
    )

    try:
        print("\n2. 临时改 compose + recreate worker")
        patch_compose(server_url)
        rc = recreate_worker()
        check("compose up worker 成功", rc == 0, f"rc={rc}")

        print("\n3. 等待注册")
        # recreate 后 IP 会变，稍等容器 ready
        time.sleep(3)
        registered = wait_registered(events, REGISTER_WAIT_S)
        check("worker 注册到 EventsServer", registered)
        if not registered:
            logs = sh(["docker", "logs", "--tail", "40", WORKER_NAME])
            print(logs.stdout[-2000:])
            print(logs.stderr[-2000:])
            return 1

        time.sleep(2)
        ip = worker_ip()
        check("获取新 worker IP", bool(ip), ip)
        base = f"http://{ip}:4198"
        print(f"  WorkerClient -> {base}")

        print("\n3b. 资源注入落盘断言（injectAll）")
        assert_resource_injection()

        client = WorkerClient(base, token=TOKEN, timeout=15)

        print("\n4. 读端点抽检")
        agents = client.list_agents("/data/vteam-worker")
        check("list_agents 非空", len(agents) > 0, f"got {len(agents)}")
        cfg = client.get_omo_config()
        check("get_omo_config", isinstance(cfg, dict) and "agents" in cfg)

        print("\n5. execute_and_wait 真实任务")
        task_id = f"e2e-close-{int(time.time())}"
        print(f"  task_id={task_id}")
        t0 = time.time()
        try:
            result = execute_and_wait(
                client,
                events,
                prompt="用一句话回答：1+1等于几？只输出数字答案。",
                task_id=task_id,
                timeout=EXEC_TIMEOUT_S,
                directory="/data/vteam-worker/tasks/e2e-sdk",
                system="第三方 SDK 闭环测试，回答尽量简短。",
            )
        except TaskTimeoutError:
            print(f"  ❌ 超时 {EXEC_TIMEOUT_S}s")
            for e in events.events_for(task_id=task_id):
                print(f"    {e['type']}: {json.dumps(e['payload'], ensure_ascii=False)[:200]}")
            logs = sh(["docker", "logs", "--tail", "50", WORKER_NAME])
            print(logs.stdout[-3000:])
            return 1
        except ExecuteError as exc:
            print(f"  ❌ execute: {exc} status={exc.status}")
            return 1

        elapsed = time.time() - t0
        check("execute_and_wait 返回", True, f"{elapsed:.1f}s")
        print(f"    elapsed   : {elapsed:.1f}s")
        print(f"    task_id   : {result.task_id}")
        print(f"    session_id: {result.session_id}")
        print(f"    status    : {result.status}")
        print(f"    output    : {result.output}")
        check("task_id 匹配", result.task_id == task_id, str(result.task_id))
        check("有 session_id", bool(result.session_id))
        # 协议：task.completed 无 status 字段；终态在 session.updated（idle/failed）
        check("output 非空（映射 text）", bool(result.output), repr(result.output))
        session_events = events.events_for(task_id=task_id, type="session.updated")
        final_status = None
        for e in session_events:
            st = (e.get("payload") or {}).get("status")
            if st in ("idle", "failed"):
                final_status = st
        check("session.updated 终态=idle", final_status == "idle", str(final_status))

        types = [e["type"] for e in events.events_for(task_id=task_id)]
        print(f"  事件序列: {types}")
        check("含 task.completed", "task.completed" in types)

        # 附带：注册信息与心跳命令通道
        check("registered_workers 可见", len(events.registered_workers()) >= 1)

        return 0 if failed == 0 else 1

    finally:
        print("\n" + "=" * 60)
        print("6. 恢复：还原 compose + recreate worker（回指 server:3000）")
        print("=" * 60)
        events.stop()
        restore_compose()
        rc = recreate_worker()
        check("恢复 recreate 成功", rc == 0, f"rc={rc}")
        # 验证 SERVER_URL 已还原
        env_out = sh(["docker", "exec", WORKER_NAME, "printenv", "SERVER_URL"])
        check(
            "worker SERVER_URL=server:3000",
            env_out.stdout.strip() == "http://server:3000",
            env_out.stdout.strip(),
        )
        # 等它注册回真实 server（查 server 侧可选）
        time.sleep(5)
        running = sh(["docker", "inspect", "-f", "{{.State.Running}}", WORKER_NAME])
        check("worker 容器 Running", running.stdout.strip() == "true", running.stdout)

        print(f"\n{'='*40}")
        print(f"PASS: {passed}  FAIL: {failed}")
        return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
