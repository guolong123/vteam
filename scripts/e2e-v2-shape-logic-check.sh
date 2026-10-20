#!/usr/bin/env bash
# =============================================================================
# T21 §3：四个 e2e 证明脚本的**形状逻辑**离线校验。
#
# 四个脚本（e2e-permission-matrix.sh / e2e-third-party-no-policy-leak.sh /
# e2e-role-boundaries.sh / e2e-native-edit-enforcement.sh）都需要**活栈**
# （运行中的 server + 部署好的 worker + 容器）才能跑完。本脚本**只**把它们读注入
# 配置的那部分 python **抽出来**（不重新实现 ⇒ 脚本改了这里跟着改），
# 打到一份**由真实 worker 注入器产出的** v2 形注入配置上：
#
#   正例：正确形状 ⇒ 每个检查都通过；
#   反例：故意破坏 v2 形状的漂移夹具 ⇒ 每个检查都**响亮失败**（证明它们不是空过）。
#
# ⚠️ **本脚本不证明活栈断言**（真 server / 真 worker 容器 / 真 DB / 真 MCP 调用）：
#   那些必须在 rollout 环境跑原脚本。本脚本只覆盖「形状读取 + 形状断言」这一层。
#
# 用法（仓库根）：
#   bash scripts/e2e-v2-shape-logic-check.sh
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# v2 形状读取器的位置（四个脚本都靠 VT_SHAPE_LIB 找到它）。
VT_SHAPE_LIB="$REPO_ROOT/scripts"
export VT_SHAPE_LIB

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vteam-shape-logic.XXXXXX")"
FIX="$WORK/fixture"
PY="$WORK/py"
mkdir -p "$PY"
trap 'rm -rf "$WORK"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1"; exit 2; }
}
need_cmd python3
need_cmd node

# ---------------------------------------------------------------- 夹具（真实注入器）
echo "--- building the v2-shaped fixture with the REAL worker injector ---"
(
  cd "$REPO_ROOT/server" &&
  TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","target":"ES2021","esModuleInterop":true,"experimentalDecorators":true,"emitDecoratorMetadata":true,"strict":false,"skipLibCheck":true}' \
    npx ts-node --transpile-only ../scripts/e2e-v2-shape-fixture.ts --out "$FIX"
) || { echo "fixture generation failed"; exit 2; }
echo "  fixture: $FIX"

# ---------------------------------------------------------------- 抽 python
# 从**脚本本身**抽 heredoc 里的 python（不重新实现 ⇒ 脚本改了这里跟着改）。
extract_heredoc() { # <script> <invocation-substring> <terminator> <out.py>
  local script="$1" marker="$2" term="$3" out="$4"
  awk -v marker="$marker" -v term="$term" '
    !started && index($0, marker) > 0 { started = 1; next }
    started && $0 == term { exit }
    started { print }
  ' "$script" > "$out"
  if [[ ! -s "$out" ]]; then
    echo "extraction failed: $script / $marker" >&2
    exit 2
  fi
}

extract_heredoc "$REPO_ROOT/scripts/e2e-permission-matrix.sh" \
  'python3 - "$SRC_JSON" "$EVIDENCE_DIR/injected-opencode.json"' EOF \
  "$PY/perm_matrix_freshness.py"
extract_heredoc "$REPO_ROOT/scripts/e2e-permission-matrix.sh" \
  'python3 - "$SRC_JSON" "$INJECTED_OUT"' EOF \
  "$PY/perm_matrix_layer1.py"
extract_heredoc "$REPO_ROOT/scripts/e2e-third-party-no-policy-leak.sh" \
  'python3 - "$TMP_DIR/endpoint.json" "$TMP_DIR/live/opencode.json"' PY \
  "$PY/leak_b1.py"
extract_heredoc "$REPO_ROOT/scripts/e2e-third-party-no-policy-leak.sh" \
  'cat >"$TMP_DIR/check.py"' PY \
  "$PY/leak_check.py"
extract_heredoc "$REPO_ROOT/scripts/e2e-role-boundaries.sh" \
  'python3 - "$INJECTED"' EOF \
  "$PY/role_boundaries_task.py"
extract_heredoc "$REPO_ROOT/scripts/e2e-native-edit-enforcement.sh" \
  'python3 - "$T8_DIR/injected-opencode.json" "$PROBE_MARKER"' EOF \
  "$PY/native_edit_probe.py"
echo "  extracted 6 python blocks from the 4 scripts"

# ---------------------------------------------------------------- 跑检查
# expect_ok <label> <py> <args...>      —— 必须通过
expect_ok() {
  local label="$1"; shift
  local out rc
  out="$(python3 "$@" 2>&1)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "$label"
  else
    fail "$label (exit=$rc)"; printf '%s\n' "$out" | sed 's/^/        /' | head -12
  fi
}
# expect_fail <label> <py> <args...>    —— 必须**响亮失败**（证明不是空过）
expect_fail() {
  local label="$1"; shift
  local out rc
  out="$(python3 "$@" 2>&1)"; rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "$label (响亮失败, exit=$rc)"
  else
    fail "$label (本该失败却通过了 ⇒ 检查器空过)"; printf '%s\n' "$out" | sed 's/^/        /' | head -12
  fi
}

GOOD="$FIX/opencode.json"
SRC="$FIX/source-constants.json"
EP="$FIX/endpoint.json"
EXT="$FIX/externals.json"

echo
echo "=== A. 正例（真实注入器产出的 v2 形状 ⇒ 检查必须通过） ==="
expect_ok "permission-matrix: step 0b 注入物新鲜度 + 无 vteam_ 动作" \
  "$PY/perm_matrix_freshness.py" "$SRC" "$GOOD"
expect_ok "permission-matrix: step 2 层① native-only 权限矩阵" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$GOOD"
expect_ok "third-party-no-policy-leak: B1 agents 段键集 vs /agent-policies" \
  "$PY/leak_b1.py" "$EP" "$GOOD"
expect_ok "third-party-no-policy-leak: 结构化泄漏检查器（clean）" \
  "$PY/leak_check.py" "$GOOD" opencode "$EXT" "$GOOD"
expect_ok "role-boundaries: 注入配置的 task/subagent 契约" \
  "$PY/role_boundaries_task.py" "$GOOD"
expect_ok "native-edit-enforcement: 探针在 edit 规则里（正例变体）" \
  "$PY/native_edit_probe.py" "$FIX/ok-edit-probe-present.json" "src/probe/**"

echo
echo "=== B. 反例（漂移夹具 ⇒ 检查必须响亮失败，证明它们不是空过） ==="
expect_fail "permission-matrix step 0b: v1 agent 段（无 v2 agents）" \
  "$PY/perm_matrix_freshness.py" "$SRC" "$FIX/drift-legacy-agent-section.json"
expect_fail "permission-matrix step 0b: 完全没有 agents 段" \
  "$PY/perm_matrix_freshness.py" "$SRC" "$FIX/drift-no-agents-section.json"
expect_fail "permission-matrix step 0b: 出现 vteam_ 动作" \
  "$PY/perm_matrix_freshness.py" "$SRC" "$FIX/drift-vteam-action.json"
expect_fail "permission-matrix step 2: vteam_ 动作" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-vteam-action.json"
expect_fail "permission-matrix step 2: 残留 v1 bash 动作" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-legacy-bash-action.json"
expect_fail "permission-matrix step 2: edit 的 '*' 被翻成 allow" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-edit-allow.json"
expect_fail "permission-matrix step 2: edit 规则不是 deny-then-allow" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-edit-order.json"
expect_fail "permission-matrix step 2: 缺 external_directory 规则" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-no-external-directory.json"
expect_fail "permission-matrix step 2: 出现 v2 不存在的 write 动作" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-write-action.json"
expect_fail "permission-matrix step 2: 少一个内置角色" \
  "$PY/perm_matrix_layer1.py" "$SRC" "$FIX/drift-missing-role.json"
expect_fail "third-party-no-policy-leak B1: v1 agent 段（无 v2 agents）" \
  "$PY/leak_b1.py" "$EP" "$FIX/drift-legacy-agent-section.json"
expect_fail "third-party-no-policy-leak B1: 完全没有 agents 段" \
  "$PY/leak_b1.py" "$EP" "$FIX/drift-no-agents-section.json"
expect_fail "third-party-no-policy-leak 结构化检查: 外部名字进了 agent 名槽位" \
  "$PY/leak_check.py" "$FIX/drift-external-name-slot.json" opencode "$EXT" "drift"
expect_fail "third-party-no-policy-leak 结构化检查: 段缺失（拒绝空过，exit 2）" \
  "$PY/leak_check.py" "$FIX/drift-no-agents-section.json" opencode "$EXT" "drift"
expect_fail "role-boundaries: 缺 subagent 规则" \
  "$PY/role_boundaries_task.py" "$FIX/drift-missing-subagent.json"
expect_fail "role-boundaries: v1 agent 段（无 v2 agents）" \
  "$PY/role_boundaries_task.py" "$FIX/drift-legacy-agent-section.json"
expect_fail "role-boundaries: 完全没有 agents 段" \
  "$PY/role_boundaries_task.py" "$FIX/drift-no-agents-section.json"
expect_fail "native-edit-enforcement: 探针不在 edit 规则里" \
  "$PY/native_edit_probe.py" "$FIX/drift-edit-probe-missing.json" "src/probe/**"

echo
echo "=== 结果 ==="
echo "  pass=$PASS_COUNT fail=$FAIL_COUNT"
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo "  RESULT: 四个脚本的**形状逻辑**离线校验通过（含漂移反例 ⇒ 检查器不空过）"
  echo "  ⚠️ 活栈断言（真 server / 真 worker 容器 / 真 DB / 真 MCP 调用）**未**在本环境跑"
  exit 0
fi
echo "  RESULT: 有检查未达预期"
exit 1
