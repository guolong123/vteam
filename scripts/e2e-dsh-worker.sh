#!/usr/bin/env bash
# ============================================================
# e2e-dsh-worker.sh —— DSH 引擎 Worker 试用栈 API 冒烟脚本
#
# 配套用例：docs/test-cases/09-DSH引擎Worker环境测试用例.md
# 覆盖：TC-DSH-001/002/005/006/007/008/010/021/023/027/030/034/046/051/055/056 的可自动化子集
#
# 用法：
#   bash scripts/e2e-dsh-worker.sh            # 全量（含真实模型对话，约 2-3 分钟）
#   bash scripts/e2e-dsh-worker.sh --quick    # 跳过真实对话轮（无 token 消耗）
#
# 依赖：curl / jq / docker（只读命令）；试用栈在 localhost:13000/13001 在跑
#
# 现场事实（2026-11-03 实测，脚本按此校准）：
#   - CreateMessageDto 字段是 **text**（不是 content），mentions 可选
#   - 消息响应形状：{message:{id,channelId,senderType,...}, triggers:[{agentId,instanceId,sessionId,status}]}
#   - 消息列表形状：{items:[{id,senderType:'user'|'agent',status,content:{text,parts:[{type:reasoning|text|step-finish}]}}]}
#   - 用量：GET /teams/:id/usage → {members:[{totalTokens,...}], teamTotal:{...}}（无 items 包装）
#   - admin/admin123 是 tm_0000000002（试用团队）owner；seed-admin 只在 tm_0000000001
#     → 频道/abort/用量类用例必须用 ADMIN
#   - abort：channel 有 teamId 时按 teamId+member 查 running 会话（teamless 频道才需要 target）
#   - capabilities.skills 是注册时刻快照（可能为空），skills 下发以**磁盘** .dsh/skills/ 为准
# ============================================================
set -u
API="${VTEAM_API:-http://localhost:13000/api/v1}"
WEB="${VTEAM_WEB:-http://localhost:13001}"
CONTAINER_WORKER="${VTEAM_WORKER_CONTAINER:-vteam-trial-worker-dsh}"
CONTAINER_INSPECT="${VTEAM_INSPECT_CONTAINER:-vteam-trial-dsh-inspect}"
DSH_VERSION_EXPECT="${VTEAM_DSH_VERSION:-0.2.2-alpha.2}"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0; FAIL=0; SKIP=0
declare -a RESULTS=()

# ── 断言工具 ────────────────────────────────────────────────────
ok()   { local n="$1" r="$2" e="$3"; if [ "$r" = "0" ]; then PASS=$((PASS+1)); RESULTS+=("PASS  $n  $e"); else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $n  $e"); fi; }
skip() { local n="$1" e="$2"; SKIP=$((SKIP+1)); RESULTS+=("SKIP  $n  $e"); }

# ── 登录：seed-admin（平台管理）+ admin（试用团队 owner） ─────────
TOKEN=$(curl -s -m 10 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"seed-admin","password":"Admin@123456"}' | jq -r '.accessToken // empty')
ok "TC-DSH-000a 登录 seed-admin" $([ -n "$TOKEN" ] && [ ${#TOKEN} -gt 100 ]; echo $?) "token_len=${#TOKEN}"
AUTH="Authorization: Bearer $TOKEN"

ADMIN=$(curl -s -m 10 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.accessToken // empty')
ok "TC-DSH-000b 登录 admin（试用团队 owner）" $([ -n "$ADMIN" ] && [ ${#ADMIN} -gt 100 ]; echo $?) "token_len=${#ADMIN}"
AAUTH="Authorization: Bearer $ADMIN"

# ── 团队/频道发现（admin 口径；显式环境变量优先） ─────────────────
TEAM="${VTEAM_TEAM:-}"
CH_GROUP="${VTEAM_GROUP_CH:-}"
CH_DEV="${VTEAM_DEV_CH:-}"
DEV_MEMBER="${VTEAM_DEV_MEMBER:-}"
if [ -n "$ADMIN" ] && [ -z "$TEAM" ]; then
  TEAM=$(curl -s -m 10 "$API/teams" -H "$AAUTH" | jq -r '.items[0].id // empty')
fi
if [ -n "$ADMIN" ] && [ -n "$TEAM" ]; then
  if [ -z "$CH_GROUP" ]; then
    CH_GROUP=$(curl -s -m 10 "$API/channels?teamId=$TEAM" -H "$AAUTH" \
      | jq -r '[.items[] | select(.type=="team_group")][0].id // empty')
  fi
  if [ -z "$CH_DEV" ] || [ -z "$DEV_MEMBER" ]; then
    # 取第一个非主 Agent 成员（alias 含"开发者"优先）
    DEV_MEMBER=$(curl -s -m 10 "$API/teams/$TEAM" -H "$AAUTH" | jq -r '
      [.members[]? | select(.agent.role != "project_manager")][0].id // empty')
    if [ -n "$DEV_MEMBER" ] && [ -z "$CH_DEV" ]; then
      CH_DEV=$(curl -s -m 10 -X POST "$API/dm-channels" -H "$AAUTH" \
        -H 'Content-Type: application/json' \
        -d "{\"teamId\":\"$TEAM\",\"teamMemberId\":\"$DEV_MEMBER\"}" | jq -r '.id // empty')
    fi
  fi
fi
ok "TC-DSH-000c 环境发现" $([ -n "$TEAM" ] && [ -n "$CH_GROUP" ] && [ -n "$CH_DEV" ]; echo $?) \
  "team=$TEAM group=$CH_GROUP dev=$CH_DEV member=$DEV_MEMBER"

# ── 1. 服务可达（TC-DSH-006） ──────────────────────────────────
H=$(curl -s -m 5 "$API/health" | jq -r '.status // empty')
ok "TC-DSH-006a server health=ok" $([ "$H" = "ok" ]; echo $?) "status=$H"
W=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$WEB/")
ok "TC-DSH-006b web 可达" $([ "$W" = "200" ]; echo $?) "http=$W"

# ── 2. worker 注册投影（TC-DSH-002） ───────────────────────────
WK=$(curl -s -m 10 "$API/workers" -H "$AAUTH")
ENG=$(echo "$WK" | jq -r '[.[] | select(.capabilities.engine=="dsh")][0].capabilities.engine // empty')
ok "TC-DSH-002a 存在 engine=dsh worker" $([ "$ENG" = "dsh" ]; echo $?) "engine=$ENG"
STATUS=$(echo "$WK" | jq -r '[.[] | select(.capabilities.engine=="dsh")][0].status // empty')
ok "TC-DSH-002b status=online" $([ "$STATUS" = "online" ]; echo $?) "status=$STATUS"
BITS=$(echo "$WK" | jq -c '[.[] | select(.capabilities.engine=="dsh")][0].capabilities.engineCapabilities // {}')
ALLFALSE=$(echo "$BITS" | jq -r 'length > 0 and ([.[]] | all(. == false))')
ok "TC-DSH-002c engineCapabilities 全 false" $([ "$ALLFALSE" = "true" ]; echo $?) "$BITS"
# skills：注册快照可能为空，以容器磁盘 .dsh/skills/ 为准（现场实测 8 个）
SKD=0; SKN="-"
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  SKD=$(docker exec "$CONTAINER_WORKER" sh -c 'ls /data/vteam-worker/.dsh/skills/ 2>/dev/null | wc -l' 2>/dev/null | tr -d ' \r')
  SKN=$(echo "$WK" | jq -r '[.[] | select(.capabilities.engine=="dsh")][0].capabilities.skills | length' 2>/dev/null)
fi
ok "TC-DSH-032a skills 已下发（磁盘为准）" $([ "${SKD:-0}" -gt 0 ] 2>/dev/null; echo $?) \
  "disk=$SKD capabilities_snapshot=$SKN"
MAXI=$(echo "$WK" | jq -r '[.[] | select(.capabilities.engine=="dsh")][0].capabilities.maxInstances // empty')
ok "TC-DSH-002d maxInstances>0" $([ "${MAXI:-0}" -gt 0 ] 2>/dev/null; echo $?) "maxInstances=$MAXI"

# ── 3. 镜像内 vendored 补丁（TC-DSH-005） ──────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  DSHV=$(docker exec $CONTAINER_WORKER dsh --version 2>/dev/null | head -1 | tr -d ' \r')
  ok "TC-DSH-005a dsh $DSH_VERSION_EXPECT" $([ "$DSHV" = "$DSH_VERSION_EXPECT" ]; echo $?) "version=$DSHV"
  VEND=$(docker exec $CONTAINER_WORKER sh -c \
    'grep -c "session/cancel\|session/steer\|session/create\|assistant-stream" $(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js' 2>/dev/null)
  ok "TC-DSH-005b vendored 补丁存在" $([ "${VEND:-0}" -ge 4 ] 2>/dev/null; echo $?) "markers=$VEND (expect>=4)"
else
  skip "TC-DSH-005" "容器 $CONTAINER_WORKER 不在运行"
fi

# ── 4. 模型目录（TC-DSH-027） ──────────────────────────────────
MDL=$(curl -s -m 10 "$API/models" -H "$AAUTH")
EN4=$(echo "$MDL" | jq -r '[.items[]? | select(.enabled==true)] | any((.modelID // "") | contains("v4.1"))')
ok "TC-DSH-027 存在 enabled 的 v4.1 模型" $([ "$EN4" = "true" ]; echo $?) \
  "$(echo "$MDL" | jq -c '[.items[]? | select(.enabled==true) | (.providerID//"")+"/"+(.modelID//"")]')"

# ── 5. Agent 角色清单（TC-DSH-030） ────────────────────────────
AGN=$(curl -s -m 10 "$API/agents" -H "$AAUTH" | jq -r '.items | length' 2>/dev/null)
ok "TC-DSH-030 agents=7（内置角色）" $([ "$AGN" = "7" ]; echo $?) "count=$AGN"

# ── 6. 凭据不落盘（TC-DSH-034） ────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  LEAK=$(docker exec $CONTAINER_WORKER sh -c \
    'grep -rE "oc_sk_[A-Za-z0-9]|sk-[A-Za-z0-9]{8}" /data/vteam-worker/.vteam/ 2>/dev/null | grep -v apiKeyEnv | head -2' || true)
  PATCHOK=$(docker exec $CONTAINER_WORKER sh -c \
    'grep -c "apiKeyEnv" /data/vteam-worker/.vteam/dsh-profile.patch.yml 2>/dev/null' 2>/dev/null | tr -d ' \r')
  ok "TC-DSH-034 patch 走 apiKeyEnv 且无明文 key" \
    $([ "${PATCHOK:-0}" -ge 1 ] 2>/dev/null && [ -z "$LEAK" ]; echo $?) \
    "apiKeyEnv行=${PATCHOK:-0} 泄漏=${LEAK:-无}"
fi

# ── 7. dsh 会话持久化落盘（TC-DSH-046） ────────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  SESN=$(docker exec $CONTAINER_WORKER sh -c 'ls /data/dsh-home/sessions/ 2>/dev/null | wc -l' | tr -d ' \r')
  ok "TC-DSH-046 DSH 侧会话文件存在" $([ "${SESN:-0}" -ge 1 ] 2>/dev/null; echo $?) "sessions文件数=${SESN:-0}"
fi

# ── 8. abort 幂等（TC-DSH-023；channel 带 teamId → 空跑返回 aborted:false）──
if [ -n "$CH_DEV" ] && [ -n "$ADMIN" ]; then
  AB=$(curl -s -m 10 -o /tmp/dsh_abort.json -w '%{http_code}' -X POST "$API/channels/$CH_DEV/abort" \
    -H "$AAUTH" -H 'Content-Type: application/json' -d '{}')
  # 注意：aborted 可为 false（无运行中会话=幂等预期）或 true（真实中止），
  # 只断言字段存在（jq 的 // 会把 false 当 falsy，必须用 has()）
  ABV=$(jq -r 'has("aborted") and has("sessions")' /tmp/dsh_abort.json 2>/dev/null)
  ok "TC-DSH-023 abort 幂等 200+结构完整" $([ "$AB" = "200" ] && [ "$ABV" = "true" ]; echo $?) \
    "http=$AB body=$(head -c 120 /tmp/dsh_abort.json)"
else
  skip "TC-DSH-023" "缺 CH_DEV/ADMIN"
fi

# ── 轮询工具：等 assistant 回复包含标记 ─────────────────────────
# 用法：wait_reply <channelId> <mark> <max_polls(5s each)> → 0=命中
# 副作用：设置全局 REPLY_POLLS=实际轮询次数（供断言证据使用）
REPLY_POLLS=0
wait_reply() {
  local ch="$1" mark="$2" polls="$3"
  local i
  for i in $(seq 1 "$polls"); do
    REPLY_POLLS=$i
    sleep 5
    curl -s -m 10 "$API/channels/$ch/messages?limit=6" -H "$AAUTH" | \
      jq -e --arg m "$mark" '[.items[]? | select(.senderType=="agent")
        | ((.content.text // "") + ([.content.parts[]? | select(.type=="text") | (.text // "")] | join("")))
        | contains($m)] | any' >/dev/null 2>&1 && return 0
  done
  return 1
}

# ── 9. 真实对话轮（TC-DSH-007/008/009/021） ─────────────────────
if [ "$QUICK" = "0" ] && [ -n "$ADMIN" ] && [ -n "$CH_DEV" ]; then
  MARK="SMOKE-$(date +%s)"
  POST=$(curl -s -m 15 -X POST "$API/channels/$CH_DEV/messages" -H "$AAUTH" \
    -H 'Content-Type: application/json' -d "{\"text\":\"请只回复：$MARK\"}")
  MSGID=$(echo "$POST" | jq -r '.message.id // empty')
  TRG=$(echo "$POST" | jq -r '.triggers | length')
  ok "TC-DSH-007a 发消息 201+triggers" $([ -n "$MSGID" ] && [ "${TRG:-0}" -ge 1 ]; echo $?) \
    "msg=$MSGID triggers=$TRG"

  if wait_reply "$CH_DEV" "$MARK" 24; then HIT=0; else HIT=1; fi
  ok "TC-DSH-007b 120s 内收到含 $MARK 的回复" $HIT "polls=$REPLY_POLLS"

  # step-finish 锚点（TC-DSH-008）：控制面完成判定与用量落库依赖它
  SF=$(curl -s -m 10 "$API/channels/$CH_DEV/messages?limit=4" -H "$AAUTH" | \
    jq -r '[.items[]? | select(.senderType=="agent")
      | .content.parts[]? | select(.type=="step-finish") | .reason] | any(. == "stop")')
  ok "TC-DSH-008 存在 step-finish(reason=stop)" $([ "$SF" = "true" ]; echo $?) "found=$SF"

  # 用量落库（TC-DSH-009）：{members:[{totalTokens...}], teamTotal}
  USG=$(curl -s -m 10 "$API/teams/$TEAM/usage" -H "$AAUTH" | \
    jq -r '[.members[]? | select(.totalTokens > 0)] | length')
  ok "TC-DSH-009 团队成员用量非空" $([ "${USG:-0}" -gt 0 ] 2>/dev/null; echo $?) "members_with_tokens=$USG"

  # 中断（TC-DSH-021）：发长任务 → abort → 返回 {aborted,...} 结构
  curl -s -m 15 -X POST "$API/channels/$CH_DEV/messages" -H "$AAUTH" \
    -H 'Content-Type: application/json' \
    -d '{"text":"请写一篇 600 字的分布式锁文章，尽量详尽。"}' >/dev/null
  sleep 8
  AB2=$(curl -s -m 10 -o /tmp/dsh_abort2.json -w '%{http_code}' -X POST "$API/channels/$CH_DEV/abort" \
    -H "$AAUTH" -H 'Content-Type: application/json' -d '{}')
  AB2V=$(jq -r 'has("aborted") and has("sessions")' /tmp/dsh_abort2.json 2>/dev/null)
  ok "TC-DSH-021 abort 200+结构完整" $([ "$AB2" = "200" ] && [ "$AB2V" = "true" ]; echo $?) \
    "http=$AB2 body=$(head -c 120 /tmp/dsh_abort2.json)"
else
  skip "TC-DSH-007/008/009/021" "--quick 或缺环境，跳过真实模型轮"
fi

# ── 10. 群聊 @ 触发（TC-DSH-010，真实轮） ───────────────────────
if [ "$QUICK" = "0" ] && [ -n "$ADMIN" ] && [ -n "$CH_GROUP" ]; then
  GM="GRP-$(date +%s)"
  curl -s -m 15 -X POST "$API/channels/$CH_GROUP/messages" -H "$AAUTH" \
    -H 'Content-Type: application/json' -d "{\"text\":\"@开发者-1 请只回复：$GM\"}" >/dev/null
  if wait_reply "$CH_GROUP" "$GM" 24; then GHIT=0; else GHIT=1; fi
  ok "TC-DSH-010 群聊 @ 开发者 120s 内回复" $GHIT "mark=$GM polls=$REPLY_POLLS"
else
  skip "TC-DSH-010" "--quick 或缺环境，跳过"
fi

# ── 11. dsh-inspect 面板（TC-DSH-051） ─────────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_INSPECT}$"; then
  INSP=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://localhost:13080/")
  # 面板需 launch token（docker logs 取）；裸访问 401/200/403 均算"在监听"
  ok "TC-DSH-051a dsh-inspect 在监听" $([ "$INSP" != "000" ]; echo $?) \
    "http=$INSP (需 token 登录, 人工核验 UI)"
else
  skip "TC-DSH-051" "容器 $CONTAINER_INSPECT 不在运行"
fi

# ── 12. 反向：无 token 401（TC-DSH-056） ────────────────────────
if [ -n "$CH_DEV" ]; then
  U=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$API/channels/$CH_DEV/messages" \
    -H 'Content-Type: application/json' -d '{"text":"x"}')
  ok "TC-DSH-056 未认证发消息 401" $([ "$U" = "401" ]; echo $?) "http=$U"
else
  skip "TC-DSH-056" "缺 CH_DEV"
fi

# ── 13. 反向：不存在频道 404（TC-DSH-055；注意字段必须合法 text）──
if [ -n "$ADMIN" ]; then
  NE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$API/channels/c_not_exist/messages" \
    -H "$AAUTH" -H 'Content-Type: application/json' -d '{"text":"x"}')
  ok "TC-DSH-055 不存在频道 404" $([ "$NE" = "404" ]; echo $?) "http=$NE (非法字段才是 400)"
else
  skip "TC-DSH-055" "缺 ADMIN"
fi

# ── 汇总 ───────────────────────────────────────────────────────
echo ""
echo "══════════════ DSH Worker 冒烟结果 ══════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "──────────────────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[ "$FAIL" = "0" ] && exit 0 || exit 1
