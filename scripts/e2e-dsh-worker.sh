#!/usr/bin/env bash
# ============================================================
# e2e-dsh-worker.sh —— DSH 引擎 Worker 试用栈 API 冒烟脚本
#
# 配套用例：docs/test-cases/09-DSH引擎Worker环境测试用例.md
# 覆盖：TC-DSH-001/002/005/006/007/010/021/023/027/030/034/046/051 的可自动化子集
#
# 用法：
#   bash scripts/e2e-dsh-worker.sh            # 全量（含真实模型对话，约 2-3 分钟）
#   bash scripts/e2e-dsh-worker.sh --quick    # 跳过真实对话轮（无 token 消耗）
#
# 依赖：curl / jq / docker（只读命令）；试用栈在 localhost:13000/13001 在跑
# ============================================================
set -u
API="http://localhost:13000/api/v1"
WEB="http://localhost:13001"
WORKER_EXEC="http://localhost:14000"
CONTAINER_WORKER="vteam-trial-worker-dsh"
CONTAINER_INSPECT="vteam-trial-dsh-inspect"
# 环境标识：默认自动发现（栈重建后 ID 会变，写死必然误报）。
# 可用环境变量覆盖：VTEAM_TEAM / VTEAM_GROUP_CH / VTEAM_DEV_CH / VTEAM_DEV_MEMBER
TEAM="${VTEAM_TEAM:-}"
CH_GROUP="${VTEAM_GROUP_CH:-}"
CH_DEV="${VTEAM_DEV_CH:-}"
DEV_MEMBER="${VTEAM_DEV_MEMBER:-}"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0; FAIL=0; SKIP=0
declare -a RESULTS=()

# ── 断言工具：ok <名称> <表达式结果 0/1> <证据摘要> ──────────────
ok()   { local n="$1" r="$2" e="$3"; if [ "$r" = "0" ]; then PASS=$((PASS+1)); RESULTS+=("PASS  $n  $e"); else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $n  $e"); fi; }
skip() { local n="$1" e="$2"; SKIP=$((SKIP+1)); RESULTS+=("SKIP  $n  $e"); }

TOKEN=$(curl -s -m 10 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"seed-admin","password":"Admin@123456"}' | jq -r '.accessToken // empty')
ok "TC-DSH-000 登录 seed-admin" $([ -n "$TOKEN" ] && [ ${#TOKEN} -gt 100 ]; echo $?) "token_len=${#TOKEN}"
AUTH="Authorization: Bearer $TOKEN"

# 自动发现团队与频道（栈重建后 ID 会变；显式环境变量优先）
if [ -n "$TOKEN" ]; then
  if [ -z "$TEAM" ]; then
    # seed-admin 可能属于多个团队；优先选**有成员绑定到 dsh worker**的那个
    # （否则取到无关团队会导致后续 abort/频道断言 403）。
    # 优先级：① 有成员绑定 dsh worker 的团队 → ② 成员最多的团队（试用团队是 7 成员）
    TEAM=$(curl -s -m 10 "$API/teams" -H "$AUTH" | jq -r '
      [.items[] | {id,
        bound: ([.members[]? | select(.preferredWorkerId=="'"${VTEAM_WORKER_ID:-w_trial_dsh}"'")] | length),
        size: (.members|length)}]
      | sort_by(-.bound, -.size) | .[0].id // empty')
    # 兜底：取第一个
    [ -z "$TEAM" ] && TEAM=$(curl -s -m 10 "$API/teams" -H "$AUTH" | jq -r '.items[0].id // empty')
  fi
  if [ -n "$TEAM" ]; then
    # 群聊频道（懒创建；先列一次确保存在）
    if [ -z "$CH_GROUP" ]; then
      CH_GROUP=$(curl -s -m 10 "$API/channels?teamId=$TEAM" -H "$AUTH" \
        | jq -r '[.items[] | select(.type=="team_group")][0].id // empty')
    fi
    # 开发者实例私聊（取第一个非主 Agent 成员）
    if [ -z "$DEV_MEMBER" ]; then
      DEV_MEMBER=$(curl -s -m 10 "$API/teams/$TEAM" -H "$AUTH" \
        | jq -r '[.members[] | select(.main != true)][0].id // empty')
    fi
    if [ -z "$CH_DEV" ] && [ -n "$DEV_MEMBER" ]; then
      CH_DEV=$(curl -s -m 10 -X POST "$API/dm-channels" -H "$AUTH" \
        -H 'Content-Type: application/json' \
        -d "{\"teamId\":\"$TEAM\",\"teamMemberId\":\"$DEV_MEMBER\"}" | jq -r '.id // empty')
    fi
  fi
fi
ok "TC-DSH-000b 环境发现" $([ -n "$TEAM" ] && [ -n "$CH_GROUP" ]; echo $?) \
  "team=$TEAM group=$CH_GROUP dev=$CH_DEV member=$DEV_MEMBER"

# ── 1. 服务可达（TC-DSH-006 前置） ─────────────────────────────
H=$(curl -s -m 5 "$API/health" | jq -r '.status // empty')
ok "TC-DSH-006a server health=ok" $([ "$H" = "ok" ]; echo $?) "status=$H"
W=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$WEB/")
ok "TC-DSH-006b web 13001 可达" $([ "$W" = "200" ]; echo $?) "http=$W"

# ── 2. worker 注册投影（TC-DSH-002/003） ───────────────────────
WK=$(curl -s -m 10 "$API/workers" -H "$AUTH")
ENG=$(echo "$WK" | jq -r '[.[] | select(.id=="w_trial_dsh")][0].capabilities.engine // empty')
STATUS=$(echo "$WK" | jq -r '[.[] | select(.id=="w_trial_dsh")][0].status // empty')
ok "TC-DSH-002a engine=dsh" $([ "$ENG" = "dsh" ]; echo $?) "engine=$ENG"
ok "TC-DSH-002b status=online" $([ "$STATUS" = "online" ]; echo $?) "status=$STATUS"
BITS=$(echo "$WK" | jq -r '[.[] | select(.id=="w_trial_dsh")][0].capabilities.engineCapabilities')
ALLFALSE=$(echo "$BITS" | jq -r '[.[]] | all(. == false)')
ok "TC-DSH-002c engineCapabilities 全 false" $([ "$ALLFALSE" = "true" ]; echo $?) "$(echo "$BITS" | jq -c .)"
SKN=$(echo "$WK" | jq -r '[.[] | select(.id=="w_trial_dsh")][0].capabilities.skills | length')
# capabilities.skills 是 worker **注册那一刻**的快照；worker 首次注册时控制面资源
# 可能尚未拉到，导致上报为空但磁盘实际已下发。故以磁盘为准判定"下发成功"。
SKD=0
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  SKD=$(docker exec "$CONTAINER_WORKER" sh -c 'ls /data/vteam-worker/.dsh/skills/ 2>/dev/null | wc -l' 2>/dev/null | tr -d ' \r')
fi
ok "TC-DSH-032a skills 已下发（磁盘为准）" $([ "${SKD:-0}" -gt 0 ] 2>/dev/null; echo $?) \
  "capabilities=$SKN disk=$SKD"
MAXI=$(echo "$WK" | jq -r '[.[] | select(.id=="w_trial_dsh")][0].capabilities.maxInstances')
ok "TC-DSH-002d maxInstances=10" $([ "$MAXI" = "10" ]; echo $?) "maxInstances=$MAXI"

# ── 3. 镜像内 vendored 补丁（TC-DSH-005） ──────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  DSHV=$(docker exec $CONTAINER_WORKER dsh --version 2>/dev/null | head -1)
  ok "TC-DSH-005a dsh 0.2.2-alpha.2" $([ "$DSHV" = "0.2.2-alpha.2" ]; echo $?) "version=$DSHV"
  VEND=$(docker exec $CONTAINER_WORKER sh -c \
    'grep -c "session/cancel\|session/steer\|session/create\|assistant-stream" $(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js' 2>/dev/null)
  ok "TC-DSH-005b vendored 补丁存在" $([ "${VEND:-0}" -ge 4 ] 2>/dev/null; echo $?) "markers=$VEND (expect>=4)"
else
  skip "TC-DSH-005" "容器 $CONTAINER_WORKER 不在运行"
fi

# ── 4. 模型目录（TC-DSH-027） ──────────────────────────────────
MDL=$(curl -s -m 10 "$API/models" -H "$AUTH")
EN4=$(echo "$MDL" | jq -r '[.items[]? | select(.enabled==true)] | any(.modelID | contains("v4.1"))')
ok "TC-DSH-027 存在 enabled 的 v4.1 模型" $([ "$EN4" = "true" ]; echo $?) "$(echo "$MDL" | jq -c '[.items[]? | select(.enabled==true) | .providerID+"/"+.modelID]')"

# ── 5. Agent 角色清单（TC-DSH-030） ────────────────────────────
AGN=$(curl -s -m 10 "$API/agents" -H "$AUTH" | jq -r '.items | length' 2>/dev/null)
ok "TC-DSH-030 agents=7（内置角色）" $([ "$AGN" = "7" ]; echo $?) "count=$AGN"

# ── 6. 凭据不落盘（TC-DSH-034） ────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  LEAK=$(docker exec $CONTAINER_WORKER sh -c \
    'grep -r "oc_sk_\|sk-" /data/vteam-worker/.vteam/ 2>/dev/null | grep -v apiKeyEnv | head -3' || true)
  PATCHOK=$(docker exec $CONTAINER_WORKER sh -c \
    'grep -c "apiKeyEnv" /data/vteam-worker/.vteam/dsh-profile.patch.yml 2>/dev/null' || echo 0)
  ok "TC-DSH-034 patch 走 apiKeyEnv 且无明文 key" $([ "${PATCHOK:-0}" -ge 1 ] 2>/dev/null && [ -z "$LEAK" ]; echo $?) "apiKeyEnv行=${PATCHOK:-0} 泄漏=${LEAK:-无}"
fi

# ── 7. dsh 会话持久化落盘（TC-DSH-046） ────────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_WORKER}$"; then
  SESN=$(docker exec $CONTAINER_WORKER sh -c 'ls /data/dsh-home/sessions/ 2>/dev/null | wc -l')
  ok "TC-DSH-046 DSH 侧会话文件存在" $([ "${SESN:-0}" -ge 1 ] 2>/dev/null; echo $?) "sessions文件数=${SESN:-0}"
fi

# ── 8. abort 幂等（TC-DSH-023，无运行中会话时） ─────────────────
AB=$(curl -s -m 10 -o /tmp/dsh_abort.json -w '%{http_code}' -X POST "$API/channels/$CH_DEV/abort" \
  -H "$AUTH" -H 'Content-Type: application/json' -d "{\"teamMemberId\":\"$DEV_MEMBER\"}")
ok "TC-DSH-023 abort 幂等 200" $([ "$AB" = "200" ]; echo $?) "http=$AB body=$(head -c 120 /tmp/dsh_abort.json)"

# ── 9. 真实对话轮（TC-DSH-007/008/009） ────────────────────────
if [ "$QUICK" = "0" ] && [ -n "$TOKEN" ]; then
  MARK="SMOKE-$(date +%s)"
  POST=$(curl -s -m 15 -X POST "$API/channels/$CH_DEV/messages" -H "$AUTH" \
    -H 'Content-Type: application/json' -d "{\"content\":\"请只回复：$MARK\"}")
  MSGID=$(echo "$POST" | jq -r '.message.id // empty')
  ok "TC-DSH-007a 发消息 201" $([ -n "$MSGID" ]; echo $?) "msg=$MSGID"

  # 轮询回复（最长 150s；dsh committed 首字约 5s，保守取整轮）
  HIT=1
  for i in $(seq 1 30); do
    sleep 5
    BODY=$(curl -s -m 10 "$API/channels/$CH_DEV/messages?limit=5" -H "$AUTH")
    if echo "$BODY" | jq -e --arg m "$MARK" '[.items[]? | select(.role=="assistant") | (.parts[]? | select(.type=="text") | .text // "")] | any(contains($m))' >/dev/null 2>&1; then
      HIT=0; break
    fi
  done
  ok "TC-DSH-007b 150s 内收到含 $MARK 的回复" $HIT "polls=$i"

  # step-finish 锚点（TC-DSH-008）：控制面完成判定依赖它
  SF=$(curl -s -m 10 "$API/channels/$CH_DEV/messages?limit=5" -H "$AUTH" | \
    jq -r '[.items[]? | select(.role=="assistant") | .parts[]? | select(.type=="step-finish") | .reason] | any(. == "stop")')
  ok "TC-DSH-008 存在 step-finish(reason=stop)" $([ "$SF" = "true" ]; echo $?) "found=$SF"

  # 用量落库（TC-DSH-009）
  USG=$(curl -s -m 10 "$API/teams/$TEAM/usage?limit=5" -H "$AUTH" | \
    jq -r 'if .items then ([.items[]? | select(.totalTokens > 0)] | length) else 0 end' 2>/dev/null)
  ok "TC-DSH-009 团队用量记录非空" $([ "${USG:-0}" -gt 0 ] 2>/dev/null; echo $?) "usage_rows=$USG"

  # 中断（TC-DSH-021）+ 中断后可继续（TC-DSH-022 简化为幂等冒烟）
  curl -s -m 15 -X POST "$API/channels/$CH_DEV/messages" -H "$AUTH" \
    -H 'Content-Type: application/json' -d '{"content":"请写一篇 600 字的分布式锁文章，尽量详尽。"}' >/dev/null
  sleep 8
  AB2=$(curl -s -m 10 -X POST "$API/channels/$CH_DEV/abort" -H "$AUTH" \
    -H 'Content-Type: application/json' -d "{\"teamMemberId\":\"$DEV_MEMBER\"}")
  ABSTATE=$(echo "$AB2" | jq -r '.aborted // empty')
  ok "TC-DSH-021 abort 返回 200" $([ -n "$ABSTATE" ]; echo $?) "body=$(echo "$AB2" | head -c 120)"
else
  skip "TC-DSH-007/008/009/021" "--quick 或未登录，跳过真实模型轮"
fi

# ── 10. 群聊 @ 触发（TC-DSH-010，真实轮） ───────────────────────
if [ "$QUICK" = "0" ] && [ -n "$TOKEN" ]; then
  GM="GRP-$(date +%s)"
  curl -s -m 15 -X POST "$API/channels/$CH_GROUP/messages" -H "$AUTH" \
    -H 'Content-Type: application/json' -d "{\"content\":\"@开发者-1 请只回复：$GM\"}" >/dev/null
  GHIT=1
  for i in $(seq 1 24); do
    sleep 5
    GB=$(curl -s -m 10 "$API/channels/$CH_GROUP/messages?limit=5" -H "$AUTH")
    if echo "$GB" | jq -e --arg m "$GM" '[.items[]? | select(.role=="assistant") | (.parts[]? | select(.type=="text") | .text // "")] | any(contains($m))' >/dev/null 2>&1; then
      GHIT=0; break
    fi
  done
  ok "TC-DSH-010 群聊 @ 开发者 120s 内回复" $GHIT "polls=$i"
else
  skip "TC-DSH-010" "--quick 或未登录，跳过"
fi

# ── 11. dsh-inspect 面板（TC-DSH-051） ─────────────────────────
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_INSPECT}$"; then
  INSP=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://localhost:13080/")
  # 面板需要 launch token，裸访问可能是 200(登录页) 或 403，只验证端口在监听
  ok "TC-DSH-051a dsh-inspect 13080 响应" $([ "$INSP" != "000" ]; echo $?) "http=$INSP (需 token 登录, 人工核验 UI)"
else
  skip "TC-DSH-051" "容器 $CONTAINER_INSPECT 不在运行"
fi

# ── 12. 反向：无 token 401（TC-DSH-056） ────────────────────────
U=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$API/channels/$CH_DEV/messages" \
  -H 'Content-Type: application/json' -d '{"text":"x"}')
ok "TC-DSH-056 未认证发消息 401" $([ "$U" = "401" ]; echo $?) "http=$U"

# ── 13. 反向：不存在频道（TC-DSH-055） ──────────────────────────
NE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$API/channels/c_not_exist/messages" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"text":"x"}')
ok "TC-DSH-055 不存在频道 404" $([ "$NE" = "404" ]; echo $?) "http=$NE"

# ── 汇总 ───────────────────────────────────────────────────────
echo ""
echo "══════════════ DSH Worker 冒烟结果 ══════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "──────────────────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[ "$FAIL" = "0" ] && exit 0 || exit 1
