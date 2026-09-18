#!/usr/bin/env bash
# Stale-claim detector for server-gate-removal-tool-authority docs (task 12).
# Exits 0 with "CLEAN" when no doc AFFIRMATIVELY asserts a removed claim.
# Removal statements (原「…」…已移除 / 不再 / 已删 / 退休 / 恒为空) are excluded.
set -uo pipefail
ROOT="${1:-docs}"
hits=0

# D1: removed server-side main-only identity gate on a retired tool.
echo "--- D1: main-only identity gate on retired tool (affirmative) ---"
d1=$(grep -rnE "仅主 ?Agent|仅主实例" "$ROOT" --include="*.md" \
  | grep -vE "不再|已移除|已删除|已删|退休|原「|身份门禁移除|恒为空|已下线" || true)
if [ -n "$d1" ]; then echo "$d1"; hits=$((hits+1)); else echo "CLEAN"; fi

# D2: plan-status dispatch requirement still asserted.
echo "--- D2: plan-status dispatch requirement (affirmative) ---"
d2=$(grep -rnE "非.{0,4}executing.{0,24}拒绝派发|拒绝派发.{0,24}非 ?executing|计划未放行" "$ROOT" --include="*.md" \
  | grep -vE "不再|已移除|已删除|已删|退休|原「|已下线|状态拒绝分支" || true)
if [ -n "$d2" ]; then echo "$d2"; hits=$((hits+1)); else echo "CLEAN"; fi

# D3: retired server-gated identity-exemption constant still asserted as live.
echo "--- D3: server-gated / identity-exemption still live (affirmative) ---"
d3=$(grep -rnE "SERVER_GATED|server-gated|serverGated|身份(豁免|门禁|判定)" "$ROOT" --include="*.md" \
  | grep -vE "不再|已移除|已删除|已删|退休|原「|恒为空|已下线|旧机制|身份门禁移除" || true)
if [ -n "$d3" ]; then echo "$d3"; hits=$((hits+1)); else echo "CLEAN"; fi

# D4: a_plan execution-exemption still live.
echo "--- D4: a_plan exemption still live (affirmative) ---"
d4=$(grep -rnE "a_plan 豁免(不变|保留)|计划员目标.{0,12}永非执行" "$ROOT" --include="*.md" \
  | grep -vE "不再|已移除|已删除|已删|退休|已下线|豁免（已删除" || true)
if [ -n "$d4" ]; then echo "$d4"; hits=$((hits+1)); else echo "CLEAN"; fi

echo "===== DETECTOR RESULT: $hits stale pattern family(ies) flagged ====="
[ "$hits" -eq 0 ] && echo "VERDICT: CLEAN — no doc asserts a removed claim" || echo "VERDICT: STALE CLAIM PRESENT"
exit "$hits"
