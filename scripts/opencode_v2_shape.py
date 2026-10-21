#!/usr/bin/env python3
"""opencode v2 注入配置（`<workDir>/opencode.json`）的**形状读取器**——唯一事实来源。

为什么单独一个模块：v2 形状（段名 / 权限形态 / action 改名 / 规则序语义）**只在这里读
一次**，`scripts/e2e-permission-matrix.sh`、`scripts/e2e-third-party-no-policy-leak.sh`、
`scripts/e2e-role-boundaries.sh`、`scripts/e2e-native-edit-enforcement.sh` 这几个读注入
配置的 e2e 证明脚本共用它 ⇒ 它们的断言口径不会各自漂移（任一处漏改 v2 ⇒ 一处假阴性）。

## v2 形状（opencode v2.0.28 实测；决策记录见
## `docs/agent-platform/07-opencode-v2-调研与架构决策.md` §3.1 / §3.2）

| 维度 | v1 | v2 |
|---|---|---|
| agent 段 | `agent: { <name>: {...} }` | **`agents: { <name>: {...} }`** |
| 权限 | **对象** `{edit: {"*":"deny"}, bash: "ask"}` | **有序数组** `permissions: [{action, resource, effect}]` |
| action 名 | `edit` / `read` / `bash` / `task` | `edit` / `read` / **`shell`**(←`bash`) / **`subagent`**(←`task`) |
| 插件段 | `plugin: [...]` | **`plugins: [...]`** |
| MCP 段 | `mcp: { <name>: {...} }` | `mcp: { servers: { <name>: {...} } }` |

## 规则顺序 = 优先级（**重建有效权限时必须按 findLast 求值**）

opencode v2 每个 agent 的**内置**规则集首条是 catch-all
`{action:"*",resource:"*",effect:"allow"}`，配置里的 `permissions[]` **追加在其后**，
规则集按 `findLast` 求值 ⇒ **最后一条命中者生效**。故从数组重建「某 action 的有效权限」
必须取**最后一条命中**规则（不能取第一条）；v1 的 `.at(-1)` 语义与之等价
（deny 在前、allow 在后）。见 `effective_effect()`。

## 纪律

- **缺段 ≠ 没泄漏**：要断言的段缺失时**抛错**（`ShapeError`），绝不当成"空结果 = 通过"
  （假阴性比没有证明更糟）。
- 形状非法（类型错 / 规则缺字段 / effect 非法）**一律抛错**，绝不静默跳过。
"""

from __future__ import annotations

import fnmatch
import json
from typing import Any

# ---------------------------------------------------------------- 段名 / 键名常量
#: v2 原生 agent 段（v1 `agent` 段已被 v2 标为 deprecated）。
AGENT_SECTION = "agents"
#: v1 agent 段名（迁移残留；非空即说明注入器还没把旧形态迁走）。
LEGACY_AGENT_SECTION = "agent"
#: v2 原生插件段（v1 `plugin`）。
PLUGIN_SECTION = "plugins"
#: v1 插件段名（迁移残留）。
LEGACY_PLUGIN_SECTION = "plugin"

# ---------------------------------------------------------------- action 改名表
#: 控制面（v1）action 名 → 注入配置（v2）action 名。
#: 实测 v2 归一化行为：`bash` → `shell`、`task` → `subagent`；其余同名沿用
#: （`read` / `edit` / `external_directory` / `vteam_*` …）。
ACTION_RENAME_V1_TO_V2 = {"bash": "shell", "task": "subagent"}
#: 注入配置（v2）action 名 → 控制面（v1）action 名（与控制面声明键集比较时用）。
ACTION_RENAME_V2_TO_V1 = {v2: v1 for v1, v2 in ACTION_RENAME_V1_TO_V2.items()}

#: v2 权限效果三态（`Permission.Effect`）。
EFFECTS = ("allow", "ask", "deny")

#: worker 补的 `external_directory` 规则（v1 语义「访问项目目录之外需询问」在 v2 下默认
#: 放行 ⇒ 必须显式补 ask）。**不是**控制面声明的原生键集的一部分。
EXTERNAL_DIRECTORY_ACTION = "external_directory"

#: v2 已把 `write` / `patch` 并入 `edit`（v2 action 命名空间里没有这两个）。
REJECTED_WRITE_ACTIONS = ("write", "patch")


class ShapeError(RuntimeError):
    """注入配置形状不合法（缺段 / 类型不对 / 规则不合法）。"""


# ---------------------------------------------------------------- action 名映射
def to_v2_action(name: str) -> str:
    """控制面（v1）action 名 → 注入配置（v2）action 名。"""
    return ACTION_RENAME_V1_TO_V2.get(name, name)


def to_v1_action(name: str) -> str:
    """注入配置（v2）action 名 → 控制面（v1）action 名。"""
    return ACTION_RENAME_V2_TO_V1.get(name, name)


# ---------------------------------------------------------------- 读取
def load(path: str) -> Any:
    """读 JSON 文件。"""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def agent_section(
    doc: Any, *, required: bool = False, where: str = "opencode.json"
) -> dict:
    """v2 `agents` 段（agent 名 → 条目）。

    `required=True` 时**缺段即抛错**——「要查的槽位不存在」不能当成「没有泄漏」。
    """
    if not isinstance(doc, dict):
        raise ShapeError("%s 不是 JSON 对象" % where)
    section = doc.get(AGENT_SECTION)
    if section is None:
        if required:
            raise ShapeError(
                "%s 缺少 v2 `%s` 段（agent 名槽位无处可查 ⇒ 拒绝空过）"
                % (where, AGENT_SECTION)
            )
        return {}
    if not isinstance(section, dict):
        raise ShapeError(
            "%s 的 `%s` 段不是对象（实际 %s）"
            % (where, AGENT_SECTION, type(section).__name__)
        )
    return section


def legacy_agent_section(doc: Any) -> dict:
    """v1 `agent` 段（迁移残留）。非空即说明注入器还没把旧形态迁走。"""
    if not isinstance(doc, dict):
        return {}
    section = doc.get(LEGACY_AGENT_SECTION)
    return section if isinstance(section, dict) else {}


def agent_names(doc: Any) -> list[str]:
    """v2 `agents` 段里的 agent 名（保持文件里的顺序）。"""
    return list(agent_section(doc).keys())


def permissions_of(entry: Any, *, where: str = "agent") -> list[dict]:
    """agent 条目 → v2 `permissions[]` 规则数组（**逐条校验形状**）。

    规则形状：`{action, resource, effect}`，`effect ∈ allow/ask/deny`。
    非法即抛 `ShapeError`（绝不静默跳过——静默跳过 = 假阴性）。
    """
    if not isinstance(entry, dict):
        raise ShapeError("%s 条目不是对象" % where)
    rules = entry.get("permissions")
    if rules is None:
        raise ShapeError("%s 条目缺少 v2 `permissions[]` 数组" % where)
    if not isinstance(rules, list):
        raise ShapeError(
            "%s 条目的 `permissions[]` 不是数组（实际 %s）"
            % (where, type(rules).__name__)
        )
    if not rules:
        raise ShapeError("%s 条目的 `permissions[]` 是空数组" % where)
    out: list[dict] = []
    for i, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise ShapeError("%s 规则[%d] 不是对象" % (where, i))
        action = rule.get("action")
        resource = rule.get("resource")
        effect = rule.get("effect")
        if not isinstance(action, str) or not action.strip():
            raise ShapeError("%s 规则[%d] 的 action 非法：%r" % (where, i, action))
        if not isinstance(resource, str) or not resource.strip():
            raise ShapeError("%s 规则[%d] 的 resource 非法：%r" % (where, i, resource))
        if effect not in EFFECTS:
            raise ShapeError(
                "%s 规则[%d] 的 effect 非法：%r（只允许 %s）"
                % (where, i, effect, "/".join(EFFECTS))
            )
        out.append({"action": action, "resource": resource, "effect": effect})
    return out


def declared_actions(rules: list[dict]) -> list[str]:
    """规则数组里声明过的 action（保序去重）。"""
    seen: list[str] = []
    for rule in rules:
        if rule["action"] not in seen:
            seen.append(rule["action"])
    return seen


def rules_for(rules: list[dict], action: str) -> list[dict]:
    """某个 action 的全部规则（保持数组原序 = 优先级）。"""
    return [rule for rule in rules if rule["action"] == action]


def _resource_matches(pattern: str, resource: str) -> bool:
    """资源模式是否命中目标资源：`*` 通配；其余按 glob 匹配（`**` 与 `*` 同义即可）。"""
    if pattern == "*":
        return True
    if pattern == resource:
        return True
    return fnmatch.fnmatchcase(resource, pattern)


def effective_rule(rules: list[dict], action: str, resource: str) -> dict | None:
    """**精确** (action, resource) 的最后一条规则（v2 里数组顺序即优先级）。"""
    hit = None
    for rule in rules:
        if rule["action"] == action and rule["resource"] == resource:
            hit = rule
    return hit


def effective_effect(rules: list[dict], action: str, resource: str = "*") -> str | None:
    """某 action 在某资源上的**有效效果**（v2 = findLast：最后一条命中者生效）。

    ⚠️ **不能取第一条**：v2 规则集按 findLast 求值（内置 catch-all allow 在最前、配置
    规则追加其后），deny-then-allow 的数组顺序**就是**优先级（与 v1 `.at(-1)` 等价）。
    """
    hit = None
    for rule in rules:
        if rule["action"] not in (action, "*"):
            continue
        if _resource_matches(rule["resource"], resource):
            hit = rule
    return None if hit is None else hit["effect"]


def plugin_entries(doc: Any) -> list[str]:
    """插件条目（v2 `plugins` + v1 `plugin` 残留——两处都查，残留也不放过）。"""
    out: list[str] = []
    if not isinstance(doc, dict):
        return out
    for key in (PLUGIN_SECTION, LEGACY_PLUGIN_SECTION):
        value = doc.get(key)
        if isinstance(value, list):
            out.extend(p for p in value if isinstance(p, str))
    return out


def triples_v1(permission: Any) -> set[tuple]:
    """v1 形权限对象 → 规则三元组集合（`(v2 action, resource, effect)`）。

    v1 的两种取值形态都摊平成三元组：三态字符串 → `resource="*"`；glob 映射 → 每个
    glob 一条。action 名统一换成 v2 名 ⇒ 可与 v2 规则数组**逐条**比对。
    """
    out: set[tuple] = set()
    if not isinstance(permission, dict):
        return out
    for action, value in permission.items():
        if isinstance(value, str):
            out.add((to_v2_action(action), "*", value))
        elif isinstance(value, dict):
            for resource, effect in value.items():
                if isinstance(effect, str):
                    out.add((to_v2_action(action), resource, effect))
    return out


def triples_v2(rules: list[dict]) -> set[tuple]:
    """v2 规则数组 → 规则三元组集合（`(action, resource, effect)`）。"""
    return {(rule["action"], rule["resource"], rule["effect"]) for rule in rules}


def _main(argv: list[str]) -> int:
    """调试入口：`python3 opencode_v2_shape.py <opencode.json>` → 打印每个 agent 的规则。"""
    if len(argv) < 2:
        print(__doc__)
        return 2
    doc = load(argv[1])
    section = agent_section(doc, required=True, where=argv[1])
    for name, entry in section.items():
        rules = permissions_of(entry, where="agent %s" % name)
        rendered = ", ".join(
            "%s[%s]=%s" % (r["action"], r["resource"], r["effect"]) for r in rules
        )
        print("%s: %s" % (name, rendered))
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
