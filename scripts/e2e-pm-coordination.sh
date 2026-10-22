#!/usr/bin/env bash
#
# e2e: 项目经理「只协调不执行」端到端证明（pm-coordination-hardening 批次 A/B/C/D/E）。
#
# 本脚本对着**本地 compose 栈**（db=MySQL8 / server=:13000 / web=:13001 / worker=:14000）
# 证明五个刚合并的 PR 真的在**真实数据库 + 真实 worker** 上生效。单测证明不了的部分：
#   ① 两份**手写 SQL 迁移**从未在任何环境执行过（本仓 CI 无本地 MySQL）——
#      迁移一列 message_receipts.settled_reason，一份回填 agent_roles.role_prompt
#      与 execution_policies.config.correction.scopeSummary；
#   ② 「引用即销账」必须真的把 message_receipts 的一行从 pending 翻成
#      status='acked' / settled_reason='quoted'；
#   ③ 「催办分级」的文案必须真的被**发出去**（不是只拼出来）。
#
# ---------------------------------------------------------------------------
# 各段证明什么（每段都必须 PASS；跳过一段永远不算通过）
# ---------------------------------------------------------------------------
#   A · 迁移生效 —— 两份手写迁移在真实库里落地：
#        A1 information_schema 里有 message_receipts.settled_reason；
#        A2 agent_roles(project_manager).role_prompt 带四条纪律条款；
#        A3 execution_policies(ep_project_manager).config.correction.scopeSummary
#           带「主动委派」条款（= 平台级【职责边界】段的渲染源）。
#   B · 派发返回值 —— 经**真实 MCP 端点** POST /api/v1/platform-mcp 调 notify_agent：
#        返回体同时带 claimed / sessionStatus / triggered（PR #59 契约），
#        且团队维度被 no-active-task 拦时**自动改走任务维度**（channelSwitched='task'）。
#   C · 引用即销账 —— 派发拿到 messageId → 群帖**精确引用**该 messageId →
#        库里那条回执行变成 status='acked' / settled_reason='quoted'（PR #61）。
#   D · 催办分级 —— **不派发**、直接种一行 pending 回执行 + 一行 receipt_nudge 触发器
#        （不派发 ⇒ 不唤醒任何 agent ⇒ 没人能回执 ⇒ 回执行必然保持 pending
#          ⇒ 催办必然发生；旧版靠「派发 + 期待对方来不及回执」，活栈上对方**会**回执，
#            回执行被结掉 ⇒ 催办无对象 ⇒ 前提错误，见 D 段注释）
#        → **真正发出去的文案**必须落在四档分级措辞之一（不是旧的单一措辞）（PR #61）。
#   E · 纪律落库 —— PM 的 role_prompt 四条纪律 + 边界段 scopeSummary 主动委派条款
#        都在**库里**（PR #60 的存量迁移真的跑了）。
#   F · 权限未被收窄 —— PM 的 agent_roles.capabilities 键集 == 服务端能力目录
#        （server/src/common/constants/platform-capability.constants.ts），
#        且 doc.submit 仍为 true、没有任何一档被置 false（PR #62 的硬约束）。
#   G · 协调度指标 —— GET /api/v1/teams/:teamId/coordination-metrics（只读 admin 端点）：
#        PM 产出物数 == 0、PM 消息占比在合理区间（PR #63）。
#
# ---------------------------------------------------------------------------
# 强制前置条件（在代码里强制，不是口头约定）
# ---------------------------------------------------------------------------
# 前置 1 — 先重建再跑（§PRE-1）
#   server/Dockerfile 把 prisma/（迁移）和 dist/（编译产物）**烤进镜像**，所以裸
#   `docker compose up -d` 跑的是**旧镜像**：新迁移不会 apply、新端点根本不存在。
#
#   ⚠️ **陷阱（已踩过一次，勿再重蹈）**：compose 里 `init` 与 `server` 是**两个不同的
#   镜像**（vteam-init:latest / vteam-server:latest）——两者虽然都 build 自 ./server，
#   但 compose 按 `<project>-<service>` 给每个服务单独打标签，各构建各的。
#   ⇒ `docker compose build server web` **只**重建 server 与 web，**不重建 init**；
#   ⇒ 随后的 `docker compose run --rm init` 跑的是**旧 vteam-init 镜像**，它烤进去的
#      prisma/migrations/ 里没有新迁移 ⇒ `prisma migrate deploy` 找不到任何新东西
#      ⇒ **两份手写迁移永远不会执行** ⇒ settled_reason 列不存在、PM 纪律正文不回填。
#   ⇒ 所以 build 列表**必须**含 init：`docker compose build server web init`。
#
#   本脚本（除非 E2E_REBUILD=0）按顺序执行：
#     docker compose build server web init   ← init 必须在列表里（见上面的陷阱）
#     [守卫] 问 init 服务自己用的镜像：里面有没有仓库里那几条迁移目录（§PRE-1c）
#     docker rm -f vteam-compose-init   （删掉已完成的一次性 init 作业）
#     docker compose up -d               （init 随之重跑：migrate deploy + seed）
#     docker compose run --rm init       （再显式跑一次一次性 init 服务）
#   `up -d` 与 `run --rm init` 都用**当前本地镜像**（up 不会自己 build）⇒ 镜像新不新
#   全看第一步 build 列表；已完成的一次性 init 作业会被 up -d 直接复用 ⇒ 必须先 rm。
#   然后 §PRE-1b 用 information_schema **证明确立**：列在、文本在；不在就**大声失败**。
#
# 前置 2 — 凭证一律不写死
#   登录用户名/口令来自 E2E_USERNAME / E2E_ADMIN_PASSWORD（回退 ADMIN_PASSWORD 环境变量，
#   再回退仓库根 .env）；DB 口令来自 compose 变量 MYSQL_ROOT_PASSWORD（回退值是
#   docker-compose.yml 里那个**开发占位符**，与既有脚本同源）；worker token 来自
#   WORKER_TOKEN 环境变量或仓库根 .env。**本文件里没有任何口令/token 字面量**。
#
# ---------------------------------------------------------------------------
# 怎么跑
# ---------------------------------------------------------------------------
#   # 默认：重建镜像 + 重跑迁移 + 全量七段
#   E2E_ADMIN_PASSWORD=<登录口令> bash scripts/e2e-pm-coordination.sh
#
#   # 只跑一次（不重建，用于「镜像已是新的」的重跑）
#   E2E_REBUILD=0 E2E_ACK_STALE_IMAGE=1 E2E_ADMIN_PASSWORD=<登录口令> \
#     bash scripts/e2e-pm-coordination.sh
#
#   证据：$EVIDENCE_DIR/e2e.txt（默认 .omo/evidence/pm-coordination/e2e.txt）。
#   本脚本创建的消息与回执行行（都是一次性的）在 cleanup 段删除并打印回执；
#   D 段种的**催办触发器**行也按 dedup_key 精确删除；**绝不删改任何种子行**
#   （团队、成员、任务、岗位、能力矩阵一律只读）。
#
# ---------------------------------------------------------------------------
# 一处**与任务描述不同**的地方（照真实代码写，不照描述写）
# ---------------------------------------------------------------------------
#   MCP 端点的工具真名是 `notify_agent`，**不是** `vteam_notify_agent`。
#   真实工具清单（server/src/platform-mcp/platform-mcp.tools.ts 的 buildToolList）
#   里 35 个工具名全是裸名（notify_agent / group_post / task_context …）；
#   `vteam_` 前缀是 **opencode 侧**给 agent 用的 MCP 别名（seed 的 mcp_servers.tools），
#   不是 JSON-RPC tools/call 的 name。传错名字服务端回 -32602 Unknown tool。
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$REPO_ROOT"

SERVER_URL="${SERVER_URL:-http://localhost:13000}"
WEB_URL="${WEB_URL:-http://localhost:13001}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/pm-coordination}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

DB_CONTAINER="${E2E_DB_CONTAINER:-vteam-compose-db}"
SERVER_CONTAINER="${E2E_SERVER_CONTAINER:-vteam-compose-server}"
WORKER_CONTAINER="${E2E_WORKER_CONTAINER:-vteam-compose-worker}"
INIT_CONTAINER="${E2E_INIT_CONTAINER:-vteam-compose-init}"
WORKER_ID="${E2E_WORKER_ID:-w_compose_worker}"

# 被证明的对象（种子团队与成员；一律只读）
TEAM_ID="${E2E_TEAM_ID:-tm_0000000001}"
PM_MEMBER_ID="${E2E_PM_MEMBER_ID:-tmm_0000000002}"     # 项目经理-1 = 团队主 Agent
PM_ROLE_KEY="${E2E_PM_ROLE_KEY:-project_manager}"
PM_POLICY_ID="${E2E_PM_POLICY_ID:-ep_project_manager}"

# build / recreate / 超时旋钮
E2E_REBUILD="${E2E_REBUILD:-1}"
E2E_ACK_STALE_IMAGE="${E2E_ACK_STALE_IMAGE:-0}"
E2E_BUILD_TIMEOUT_SEC="${E2E_BUILD_TIMEOUT_SEC:-3600}"
E2E_HEALTH_TIMEOUT_SEC="${E2E_HEALTH_TIMEOUT_SEC:-420}"
E2E_NUDGE_WAIT_SEC="${E2E_NUDGE_WAIT_SEC:-200}"          # 一次催办尝试的最长等待
E2E_NUDGE_ATTEMPTS="${E2E_NUDGE_ATTEMPTS:-6}"            # 催办目标尝试次数（换人重试；团队里非主成员共 6 个）
E2E_D_NUDGE_DELAY_SEC="${E2E_D_NUDGE_DELAY_SEC:-45}"     # D 段：催办触发器 due_at = now + N 秒
E2E_D_EXPIRY_MARGIN_SEC="${E2E_D_EXPIRY_MARGIN_SEC:-0}" # D 段：回执行 expires_at = due_at + N 秒（0 = 完全贴平台真实形态；平台宽限窗已保证催办先赢）
E2E_D_TEXT_WAIT_SEC="${E2E_D_TEXT_WAIT_SEC:-150}"        # D 段：等催办文案出现在 worker 会话里的最长时间
E2E_MCP_TIMEOUT_SEC="${E2E_MCP_TIMEOUT_SEC:-120}"

# 凭证（无口令字面量；见文件头「前置 2」）
E2E_USERNAME="${E2E_USERNAME:-admin}"
if [[ -z "${E2E_ADMIN_PASSWORD:-}" ]]; then
  E2E_ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
fi
if [[ -z "$E2E_ADMIN_PASSWORD" && -f "$REPO_ROOT/.env" ]]; then
  E2E_ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ' || true)"
fi
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-vteam-root}"   # docker-compose.yml 的开发占位符
WORKER_TOKEN="${WORKER_TOKEN:-}"
if [[ -z "$WORKER_TOKEN" && -f "$REPO_ROOT/.env" ]]; then
  WORKER_TOKEN="$(grep -E '^WORKER_TOKEN=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ' || true)"
fi

# ---------------------------------------------------------------- 被断言的真实文案（逐条注明出处）
# PM 岗位定义的四条纪律（server/src/common/constants/agent-role-prompts.constants.ts
# 的 BUILTIN_ROLE_PROMPTS.project_manager；守卫 spec：
# server/src/common/constants/pm-coordination-discipline.spec.ts 的
# '① 三步判定' / '② 冲突裁决' / '③ 串行派活' / '④ 做完即停'）
# 批次 D：纪律正文岗位无关（不写死「需求→产品经理」这类行业映射），只保留判定程序。
PM_DISCIPLINE_HEADS=(
  "【判定顺序·任何请求先过这一步】"
  "【冲突裁决】"
  "串行派活"
  "做完即停"
)
# 平台级【职责边界】段的主动委派条款
# （server/src/common/constants/agent.constants.ts 的
#  ROLE_BOUNDARIES['vteam-project_manager'].scopeSummary；
#  守卫 spec 断言它含 '产出归谁由各岗位职责界定' 与 '你只产出派发与核验'）
PM_SCOPE_CLAUSES=("产出归谁由各岗位职责界定" "你只产出派发与核验")
# 催办文案四档（server/src/chat/receipt-nudge.handler.ts 的 buildNudgeDiagnosis：
#   not-started / delivered-unsettled / receipt-not-landed / unknown）
GRADED_NUDGE_CASES=(
  "平台没有看到你的任何回复或产出物"     # not-started
  "已经记到你的交付"                    # delivered-unsettled
  "查不到你的回执记录"                  # receipt-not-landed
  "未能确证当前态势"                    # unknown（证不出来时的通用文案）
)
# 催办文案的固定抬头与落款（buildAutoNudgeText）
NUDGE_HEADER="【平台自动催办·第1次】"

# ---------------------------------------------------------------- helpers
E2E_LOG="$EVIDENCE_DIR/e2e.txt"
: >"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() {
  printf '[e2e] FAIL step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  E2E_RC=1
  exit 1
}
note() { printf '[e2e] NOTE %s\n' "$*" | tee -a "$E2E_LOG"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$E2E_LOG"; exit 2; }
}
need_cmd curl
need_cmd python3
need_cmd docker

TMP_FILES=""
mktmp() { local f; f="$(mktemp)"; TMP_FILES="$TMP_FILES $f"; printf '%s' "$f"; }

# jget <json-file> <python-expr on `d`>
jget() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
v='"$2"'
print("" if v is None else (v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))' "$1"
}

# notify_field <json-file> <field>：MCP notify_agent 返回体的字段读取器。
# 三态严格区分（这是 PR #59 契约的关键：sessionStatus 允许为 null，但**不能缺**）：
#   __MISSING__ = 返回体里根本没有这个键（契约缺失 ⇒ 失败）
#   null        = 键在，值是 null（契约合法）
#   其它        = 键在且有值
notify_field() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
k=sys.argv[2]
if not isinstance(d,dict) or k not in d:
    print("__MISSING__")
else:
    v=d[k]
    if v is None: print("null")
    elif isinstance(v,str): print(v)
    else: print(json.dumps(v,ensure_ascii=False))' "$1" "$2"
}

# trunc <file|-> <chars>：按**字符**截断并把换行压成空格。
# 不用 head -c：那是按字节切，会把一个 UTF-8 汉字切成半个字节，
# 于是证据日志里出现非法字节，grep/awk 会报 multibyte conversion failure。
# ⚠️ 必须补一个结尾换行：本函数常被直接接在管道里喂给 tee/sed，没有换行的话
#    **下一条日志会被粘到这一行尾巴上** ⇒ 形如 `^\[e2e\] PASS X ` 的行首锚定
#    grep 就会漏判（曾把一个真的 PASS D 判成「没有 PASS 行」）。
trunc() { # $1 = 文件路径（"-" 读 stdin）, $2 = 字符数
  python3 -c 'import sys
n=int(sys.argv[2])
src=sys.argv[1]
s=sys.stdin.read() if src=="-" else open(src,encoding="utf-8",errors="replace").read()
sys.stdout.write(s[:n].replace("\n"," ") + "\n")' "$1" "$2"
}

# api <METHOD> <path incl. /api/v1> [json-body] → API_CODE / API_OUT
TOKEN=""
api() {
  local method="$1" path="$2" body="${3:-}"
  API_OUT="$(mktmp)"
  local -a args=(-sS -o "$API_OUT" -w '%{http_code}' -X "$method" "$SERVER_URL$path"
                 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
  [[ -n "$body" ]] && args+=(--data "$body")
  API_CODE="$(curl "${args[@]}" || echo 000)"
}
assert2xx() { # $1 = step label
  case "$API_CODE" in
    2*) return 0 ;;
  esac
  fail "$1" "HTTP $API_CODE body=$(trunc "$API_OUT" 300)"
}

# dbq <sql>：在 compose db 容器里跑一条语句（stdout → ${DB_OUT}）
# --default-character-set=utf8mb4 必须带：否则中文正文按 latin1 往返，断言会假阴性。
DB_OUT="$(mktmp)"; DB_ERR="$(mktmp)"
dbq() {
  docker exec "$DB_CONTAINER" mysql --default-character-set=utf8mb4 \
    -uroot -p"$MYSQL_ROOT_PASSWORD" -D vteam -N -e "$1" \
    >"$DB_OUT" 2>"$DB_ERR"
}
dbval() { head -1 "$DB_OUT" 2>/dev/null | tr -d '\r'; }   # 单值查询结果

# ---- 平台 MCP 端点（server/src/platform-mcp/platform-mcp.controller.ts）
# POST /api/v1/platform-mcp，headers: X-Worker-Token + x-worker-id；
# body: {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{name,arguments}}；
# 成功时 result.content[0].text 是 handler 返回值的 **JSON 字符串** ⇒ 必须再 parse 一层。
MCP_RAW="$(mktmp)"; MCP_RESULT="$(mktmp)"
mcp_call() { # $1 = 工具真名, $2 = arguments(JSON), $3 = 段标签
  local tool="$1" args="$2" label="$3"
  local body; body="$(mktmp)"
  printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' \
    "$tool" "$args" >"$body"
  MCP_CODE="$(curl -sS --max-time "$E2E_MCP_TIMEOUT_SEC" -o "$MCP_RAW" -w '%{http_code}' \
    -X POST "$SERVER_URL/api/v1/platform-mcp" \
    -H "X-Worker-Token: $WORKER_TOKEN" -H "x-worker-id: $WORKER_ID" \
    -H 'Content-Type: application/json' --data @"$body" || echo 000)"
  # result.content[0].text → JSON 字符串 → 再 parse 成对象（失败则写一个可读的错对象）
  python3 - "$MCP_RAW" "$MCP_RESULT" <<'PY' || true
import json, sys
raw, out = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(raw))
except Exception as e:
    json.dump({"_parse_error": "bad json: %s" % e}, open(out, "w"), ensure_ascii=False); raise SystemExit(0)
if isinstance(d, dict) and "error" in d:
    json.dump({"_mcp_error": d["error"]}, open(out, "w"), ensure_ascii=False); raise SystemExit(0)
try:
    text = d["result"]["content"][0]["text"]
except Exception as e:
    json.dump({"_mcp_error": "no result.content[0].text: %s" % e, "_raw": d}, open(out, "w"), ensure_ascii=False); raise SystemExit(0)
try:
    json.dump(json.loads(text), open(out, "w"), ensure_ascii=False)
except Exception as e:
    json.dump({"_mcp_error": "content[0].text is not JSON: %s" % e, "_raw_text": text[:2000]}, open(out, "w"), ensure_ascii=False)
PY
  if [[ -n "${label:-}" ]]; then
    log "$label mcp http=$MCP_CODE result=$(trunc "$MCP_RESULT" 400)"
  fi
}

# ---- worker 的 opencode 会话消息（催办文案真正落地的地方）
# receipt-nudge.handler 把催办文案交给 workerDispatcher.dispatchAgentMention，
# server 不落库、不打日志 ⇒ 唯一可观测处是 worker 侧 opencode 会话里的 **user 消息**。
# worker 执行端点 GET /sessions/:id/messages（X-Worker-Token 鉴权）在容器内 4198 端口。
# $2 可选：给 'asc'/'desc' 时追加 &order=（长会话里催办是最新的那条，asc+limit 会漏掉它；
# 老 worker 镜像若不认 order 参数会忽略/报错 ⇒ 只作兜底，默认口径不变）。
WORKER_EXEC_PORT="$(docker exec "$WORKER_CONTAINER" sh -c 'printf %s "${WORKER_EXEC_PORT:-4198}"' 2>/dev/null || echo 4198)"
WORKER_FETCH_JS='const port=process.env.WPORT||"4198";const url="http://127.0.0.1:"+port+"/sessions/"+encodeURIComponent(process.env.SID||"")+"/messages?limit=200"+(process.env.WQ||"");fetch(url,{headers:{"X-Worker-Token":process.env.WT||""}}).then(function(r){return r.json();}).then(function(d){const out=[];for(const m of (d.messages||[])){for(const p of (m.parts||[])){if(p&&p.type==="text"&&typeof p.text==="string"){out.push(p.text);}}}console.log(JSON.stringify(out));}).catch(function(){console.log("[]");});'
worker_session_texts() { # $1 = opencode session id, $2 = 可选 order（asc|desc）→ JSON 数组（每个元素一段文本）
  local wq=""
  if [[ -n "${2:-}" ]]; then wq="&order=$2"; fi
  docker exec -e WT="$WORKER_TOKEN" -e SID="$1" -e WQ="$wq" -e WPORT="$WORKER_EXEC_PORT" \
    "$WORKER_CONTAINER" node -e "$WORKER_FETCH_JS" 2>/dev/null || echo '[]'
}

# 本次运行创建的一次性数据（消息 id / 回执行 id / 催办触发器 id），cleanup 段删除
CREATED_MESSAGE_IDS=""
CREATED_RECEIPT_IDS=""
CREATED_TRIGGER_IDS=""
remember_message() { CREATED_MESSAGE_IDS="$CREATED_MESSAGE_IDS $1"; }
remember_receipt() { CREATED_RECEIPT_IDS="$CREATED_RECEIPT_IDS $1"; }
remember_trigger() { CREATED_TRIGGER_IDS="$CREATED_TRIGGER_IDS $1"; }

E2E_RC=0
cleanup() {
  local rc="${E2E_RC:-0}"
  set +e
  log "----- cleanup receipt -----"
  # 1. 打印本次创建的回执行（删除前）
  if [[ -n "${CREATED_RECEIPT_IDS// /}" ]]; then
    local id_list="" id
    for id in $CREATED_RECEIPT_IDS; do
      [[ -n "$id_list" ]] && id_list="$id_list,"
      id_list="$id_list'$id'"
    done
    if dbq "SELECT id, message_id, from_instance_id, to_instance_id, status, settled_reason, nudge_count FROM message_receipts WHERE id IN ($id_list) ORDER BY id;"; then
      sed 's/^/[e2e] receipt| /' "$DB_OUT" | tee -a "$E2E_LOG"
    fi
    if dbq "DELETE FROM message_receipts WHERE id IN ($id_list);"; then
      dbq "SELECT COUNT(*) FROM message_receipts WHERE id IN ($id_list);"
      log "cleanup: db DELETE message_receipts ($id_list) ok, rows left = $(dbval)"
    else
      log "cleanup: WARNING could not delete receipts: $(trunc "$DB_ERR" 200)"
    fi
  else
    log "cleanup: no receipts created by this run"
  fi
  # 1.5 删除本脚本为这些回执行排的**催办触发器**（含平台在催办后补排的到期 trigger：
  #     dedup_key = receipt_nudge:<teamId>:<receiptId>[ :expiry]）
  #     只按本脚本自建回执的 id 精确匹配 ⇒ 绝不碰别人的触发器行。
  #     （B/C 段的回执行也是本脚本派发出来的 ⇒ 它们的催办触发器同样属于本次运行的产物。）
  if [[ -n "${CREATED_RECEIPT_IDS// /}" ]]; then
    for id in $CREATED_RECEIPT_IDS; do
      if dbq "DELETE FROM \`triggers\` WHERE dedup_key='receipt_nudge:$TEAM_ID:$id' OR dedup_key='receipt_nudge:$TEAM_ID:$id:expiry';"; then
        dbq "SELECT COUNT(*) FROM \`triggers\` WHERE dedup_key='receipt_nudge:$TEAM_ID:$id' OR dedup_key='receipt_nudge:$TEAM_ID:$id:expiry';"
        log "cleanup: db DELETE triggers (receipt_nudge:$TEAM_ID:$id[ :expiry]) ok, rows left = $(dbval)"
      else
        log "cleanup: WARNING could not delete triggers for receipt $id: $(trunc "$DB_ERR" 200)"
      fi
    done
  fi
  if [[ -n "${CREATED_TRIGGER_IDS// /}" ]]; then
    log "cleanup: 本脚本种下的催办触发器（已随上面的 dedup_key 一起删除）：$CREATED_TRIGGER_IDS"
  fi
  # 2. 删除本次创建的消息（只删本脚本建的；种子消息一律不动）
  if [[ -n "${CREATED_MESSAGE_IDS// /}" ]]; then
    local id_list="" id
    for id in $CREATED_MESSAGE_IDS; do
      [[ -n "$id_list" ]] && id_list="$id_list,"
      id_list="$id_list'$id'"
    done
    if dbq "DELETE FROM messages WHERE id IN ($id_list);"; then
      dbq "SELECT COUNT(*) FROM messages WHERE id IN ($id_list);"
      log "cleanup: db DELETE messages ($id_list) ok, rows left = $(dbval)"
    else
      log "cleanup: WARNING could not delete messages: $(trunc "$DB_ERR" 200)"
    fi
  else
    log "cleanup: no messages created by this run"
  fi
  # 3. 复核：种子团队/成员/任务/岗位/能力矩阵一行都没动
  if dbq "SELECT (SELECT COUNT(*) FROM teams WHERE id='$TEAM_ID') AS team, (SELECT COUNT(*) FROM team_members WHERE team_id='$TEAM_ID') AS members, (SELECT COUNT(*) FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY') AS role, (SELECT COUNT(*) FROM execution_policies WHERE id='$PM_POLICY_ID') AS policy;"; then
    log "cleanup: seeded rows untouched (team=$(dbval))"
  fi
  # 4. 残留如实记账：本次跑出来的、但**不是**本脚本创建的行（被 @ 唤醒的 agent 自己的回复、
  #    平台为成员新建的会话行）——本脚本不删它们（不是我们的行），但必须报出来，
  #    否则「行数没变」会被误读成「什么都没发生」。
  if dbq "SELECT (SELECT COUNT(*) FROM messages WHERE created_at >= FROM_UNIXTIME($RUN_START_EPOCH)) AS msgs, (SELECT COUNT(*) FROM message_receipts WHERE created_at >= FROM_UNIXTIME($RUN_START_EPOCH)) AS receipts, (SELECT COUNT(*) FROM sessions WHERE created_at >= FROM_UNIXTIME($RUN_START_EPOCH)) AS sessions;"; then
    log "cleanup: 本次运行期间新建（未由本脚本创建，故未删）: $(dbval)"
  fi
  # 4. 临时文件
  # shellcheck disable=SC2086
  rm -f $TMP_FILES 2>/dev/null || true
  # 5. 出口闸门：只有总结守卫能授权 exit 0。中途夭折 ⇒ 强制 1。
  if ! grep -q '^\[e2e\] all seven segments (A/B/C/D/E/F/G) PASS' "$E2E_LOG"; then
    rc=1
    log "EXIT CODE OVERRIDDEN to 1: the summary guard never passed, so this run did NOT prove A/B/C/D/E/F/G — a skipped or unrun segment is never a pass"
  fi
  log "----- exit code: $rc -----"
  exit "$rc"
}
trap cleanup EXIT

# login_admin : 用环境里解析出来的凭证换 JWT（口令值永不打印、永不断言）
login_admin() {
  [[ -n "$E2E_ADMIN_PASSWORD" ]] || fail "pre-auth" "$(
    printf 'no admin password supplied. Set E2E_ADMIN_PASSWORD (or ADMIN_PASSWORD, or ADMIN_PASSWORD= in the repo-root .env). This script deliberately hardcodes no password.'
  )"
  [[ -n "$WORKER_TOKEN" ]] || fail "pre-auth" "$(
    printf 'no worker token supplied. Set WORKER_TOKEN (or WORKER_TOKEN= in the repo-root .env). This script deliberately hardcodes no token.'
  )"
  local body out
  body="$(mktmp)"; out="$(mktmp)"
  printf '{"username":"%s","password":"%s"}' "$E2E_USERNAME" "$E2E_ADMIN_PASSWORD" >"$body"
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data @"$body")"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    fail "pre-auth" "login as $E2E_USERNAME failed: HTTP $code body=$(trunc "$out" 300)"
  fi
  TOKEN="$(jget "$out" 'd.get("accessToken") or d.get("access_token") or ""')"
  [[ -n "$TOKEN" ]] || fail "pre-auth" "login response carried no accessToken"
  log "PRE-0 logged in as $E2E_USERNAME (token acquired, value not logged)"
}

# ===========================================================================
# PRE-0 — 环境可达性
# ===========================================================================
RUN_ID="e2e-pm-coord-$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_START_EPOCH="$(date +%s)"
log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD) branch=$(git rev-parse --abbrev-ref HEAD)"
log "RUN_ID=$RUN_ID (每次运行唯一 ⇒ 引用/去重探针不会命中上一轮)"
log "SERVER_URL=$SERVER_URL WEB_URL=$WEB_URL EVIDENCE_DIR=$EVIDENCE_DIR"
log "TEAM_ID=$TEAM_ID PM_MEMBER_ID=$PM_MEMBER_ID WORKER_ID=$WORKER_ID"

DOCKER_VERSION_OUT="$(mktmp)"
DOCKER_VERSION_RC=0
docker version >"$DOCKER_VERSION_OUT" 2>&1 || DOCKER_VERSION_RC=$?
log "PRE-0 docker version (exit=$DOCKER_VERSION_RC):"
sed 's/^/[e2e]   /' "$DOCKER_VERSION_OUT" | tee -a "$E2E_LOG"
[[ "$DOCKER_VERSION_RC" -eq 0 ]] || fail "pre-docker" "docker daemon unreachable (run 'docker version' to see the raw error)"
docker compose version >/dev/null 2>&1 || fail "pre-docker" "docker compose plugin missing"

wait_http() { # $1 url, $2 timeout
  local url="$1" timeout="$2" code
  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
    [[ "$code" == "200" ]] && return 0
    sleep 3
  done
  return 1
}

PRE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null || echo 000)"
if [[ "$PRE_CODE" != "200" ]]; then
  if [[ "$E2E_REBUILD" != "1" ]]; then
    fail "pre-health" "server not healthy at $SERVER_URL (E2E_REBUILD=$E2E_REBUILD ⇒ this run neither built nor recreated the stack; run with E2E_REBUILD=1)"
  fi
  log "PRE-0 stack not up yet (health=$PRE_CODE) — PRE-1 will build + recreate it"
fi

# ---------------------------------------------------------------------------
# PRE-0b — 脚本**自检**：不允许出现「$VAR 紧跟非 ASCII 字符」的展开点。
#   UTF-8 locale 下 bash 的变量名解析会把紧跟的非 ASCII 字符吞进变量名
#   （"$B_SESSION" 后面跟一个全角右括号，会被当成变量 B_SESSION<全角右括号>）
#   → set -u 立刻炸，且报错信息里那个变量名带着乱码，极难定位。
#   这个坑本脚本已经踩过一次（21 处），所以用自检钉死：
#   凡是变量后可能跟中文/全角标点，一律写成 ${VAR}。
# ---------------------------------------------------------------------------
SELFCHECK_BAD="$(python3 - "$SCRIPT_PATH" <<'PY'
import re, sys
data = open(sys.argv[1], "rb").read()
pat = re.compile(rb"\$([A-Za-z_][A-Za-z0-9_]*)")
bad = []
for i, raw in enumerate(data.split(b"\n"), 1):
    if raw.lstrip().startswith(b"#"):   # 注释行不参与展开，跳过（否则自检会误报自己）
        continue
    for m in pat.finditer(raw):
        e = m.end()
        if e < len(raw) and raw[e] >= 0x80:
            bad.append("line %d: $%s" % (i, m.group(1).decode()))
print("; ".join(bad))
PY
)"
[[ -z "$SELFCHECK_BAD" ]] \
  || fail "pre-selfcheck" "脚本自身存在「\$VAR 紧跟非 ASCII 字符」的展开点：${SELFCHECK_BAD}。UTF-8 locale 下 bash 会把该字符吞进变量名，set -u 会直接炸。修法：写成 \${VAR}。"
log "PRE-0b self-check PASS (no \$VAR immediately followed by a non-ASCII byte)"

# ===========================================================================
# PRE-1 — 先重建再跑（强制；见文件头「前置 1」）
# ===========================================================================
if [[ "$E2E_REBUILD" == "1" ]]; then
  BUILD_OUT="$(mktmp)"
  BUILD_RC=0
  log "PRE-1 docker compose build server web init (timeout ${E2E_BUILD_TIMEOUT_SEC}s)"
  log "PRE-1 NOTE init 必须在 build 列表里：compose 按 <project>-<service> 给每个服务单独打镜像标签（vteam-init / vteam-server / vteam-web），build server web 不会重建 vteam-init ⇒ 迁移会从旧镜像里跑"
  docker compose build server web init >"$BUILD_OUT" 2>&1 &
  BUILD_PID=$!
  ( sleep "$E2E_BUILD_TIMEOUT_SEC"; kill "$BUILD_PID" 2>/dev/null || true ) &
  WATCH_PID=$!
  wait "$BUILD_PID" || BUILD_RC=$?
  kill "$WATCH_PID" 2>/dev/null || true
  tail -40 "$BUILD_OUT" | sed 's/^/[e2e] build| /' | tee -a "$E2E_LOG"
  log "PRE-1 docker compose build server web init exit=$BUILD_RC"
  [[ "$BUILD_RC" -eq 0 ]] || fail "pre1-build" "docker compose build server web init failed (exit=$BUILD_RC; raw above)"

  # ---------------------------------------------------------------------------
  # PRE-1c — 镜像里到底有没有新迁移（build 列表漏了 init 的直接探针）
  #   不猜镜像名（compose 按 <project>-<service> 命名），直接问 **init 服务自己会用的
  #   那个镜像**：仓库里有的迁移目录，镜像里必须一条不少。这条守卫专治
  #   「build 了但 init 镜像是旧的 ⇒ migrate deploy 什么也不做」这个静默失败。
  # ---------------------------------------------------------------------------
  REPO_MIGRATIONS="$(ls "$REPO_ROOT/server/prisma/migrations" 2>/dev/null | grep -E '^[0-9]{14}_' | sort || true)"
  [[ -n "$REPO_MIGRATIONS" ]] || fail "pre1-image-guard" "读不到 $REPO_ROOT/server/prisma/migrations 下的迁移目录"
  for SVC in init server; do
    IMG_MIGRATIONS="$(docker compose run --rm --no-deps --entrypoint sh "$SVC" -c 'ls prisma/migrations' 2>/dev/null | grep -E '^[0-9]{14}_' | sort || true)"
    MISSING_MIGRATIONS="$(comm -23 <(printf '%s\n' "$REPO_MIGRATIONS") <(printf '%s\n' "$IMG_MIGRATIONS"))"
    log "PRE-1c $SVC 镜像内迁移目录 $(printf '%s\n' "$IMG_MIGRATIONS" | wc -l | tr -d ' ') 条；仓库 $(printf '%s\n' "$REPO_MIGRATIONS" | wc -l | tr -d ' ') 条"
    [[ -z "${MISSING_MIGRATIONS// /}" ]] \
      || fail "pre1-image-guard" "$(
        printf 'the %s image does NOT contain these migrations: %s — the image is stale. server/Dockerfile bakes prisma/ into the image, so `docker compose build server web` alone leaves vteam-init stale and `prisma migrate deploy` would apply nothing. Fix: docker compose build server web init.' "$SVC" "$MISSING_MIGRATIONS"
      )"
  done
  log "PRE-1c image guard PASS (both init and server images carry every repo migration)"

  # 一个已完成的 init 作业会被 `up -d` 直接复用 ⇒ 迁移不会重跑。删掉它。
  # 删掉之后 `up -d` 会用**当前本地镜像**（刚 build 好的 vteam-init）新建并跑它。
  if docker inspect "$INIT_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$INIT_CONTAINER" >/dev/null 2>&1 || true
    log "PRE-1 removed completed init job $INIT_CONTAINER so prisma migrate deploy + seed re-run"
  fi

  UP_OUT="$(mktmp)"
  UP_RC=0
  log "PRE-1 docker compose up -d"
  docker compose up -d >"$UP_OUT" 2>&1 || UP_RC=$?
  cat "$UP_OUT" | sed 's/^/[e2e] up| /' | tee -a "$E2E_LOG"
  log "PRE-1 docker compose up -d exit=$UP_RC"
  [[ "$UP_RC" -eq 0 ]] || fail "pre1-up" "docker compose up -d failed (exit=$UP_RC; raw above)"

  # 再显式跑一次一次性 init 服务（migrate deploy + seed），确保新迁移确实落库。
  # `compose run` 同样用当前本地镜像 ⇒ 镜像新不新取决于上面的 build 列表（含 init）。
  INIT_OUT="$(mktmp)"
  INIT_RC=0
  log "PRE-1 docker compose run --rm init"
  docker compose run --rm init >"$INIT_OUT" 2>&1 || INIT_RC=$?
  tail -30 "$INIT_OUT" | sed 's/^/[e2e] init| /' | tee -a "$E2E_LOG"
  log "PRE-1 docker compose run --rm init exit=$INIT_RC"
  if [[ "$INIT_RC" -ne 0 ]]; then
    # `up -d` 已经让 init 服务重跑过一次；这里失败多半是 compose 的容器名冲突。
    # 真相由 PRE-1b 的 information_schema 守卫裁决，不在这里猜。
    note "PRE-1 docker compose run --rm init failed (exit=$INIT_RC) — the authoritative check is the PRE-1b schema guard below (the init service also ran as part of 'up -d')"
  fi
else
  log "PRE-1 SKIPPED (E2E_REBUILD=0)"
  if [[ "$E2E_ACK_STALE_IMAGE" != "1" ]]; then
    fail "pre1-stale" "E2E_REBUILD=0 requires E2E_ACK_STALE_IMAGE=1. A bare up -d on a stale image means the new migration is absent (message_receipts.settled_reason missing) and the new endpoint does not exist. Mind that 'init' has its own image: rebuilding only server+web leaves vteam-init stale, so migrate deploy would apply nothing. Re-run with the defaults, or pass E2E_REBUILD=0 E2E_ACK_STALE_IMAGE=1."
  fi
  log "PRE-1 STALE-IMAGE ACK: E2E_ACK_STALE_IMAGE=1 — accepted by the caller. The PRE-1b schema guard still proves the columns exist."
fi

log "PRE-1 waiting for server health (timeout ${E2E_HEALTH_TIMEOUT_SEC}s)"
wait_http "$SERVER_URL/api/v1/health" "$E2E_HEALTH_TIMEOUT_SEC" \
  || fail "pre1-health" "server /api/v1/health never returned 200 within ${E2E_HEALTH_TIMEOUT_SEC}s"
log "PRE-1 server healthy; docker compose ps:"
docker compose ps | sed 's/^/[e2e] ps| /' | tee -a "$E2E_LOG"
login_admin

# ---------------------------------------------------------------------------
# PRE-1b — 迁移落地的**权威守卫**：information_schema + 库里正文
#   列不在 ⇒ 跑的是旧镜像 ⇒ 后面几段必然是假通过 ⇒ 这里必须大声失败。
# ---------------------------------------------------------------------------
SCHEMA_OK=1
if dbq "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='message_receipts' AND column_name='settled_reason';"; then
  N="$(dbval)"
else
  N="query-failed: $(trunc "$DB_ERR" 200)"
fi
log "PRE-1b information_schema message_receipts.settled_reason count=$N"
[[ "$N" == "1" ]] || SCHEMA_OK=0

ROLE_PROMPT_HITS=""
for head_text in "${PM_DISCIPLINE_HEADS[@]}"; do
  if dbq "SELECT LOCATE('$head_text', role_prompt) FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY';"; then
    hit="$(dbval)"
  else
    hit="query-failed"
  fi
  ROLE_PROMPT_HITS="$ROLE_PROMPT_HITS|$head_text=$hit"
  [[ "$hit" =~ ^[1-9] ]] || SCHEMA_OK=0
done
log "PRE-1b agent_roles($PM_ROLE_KEY).role_prompt discipline hits:$ROLE_PROMPT_HITS"

SCOPE_HITS=""
for clause in "${PM_SCOPE_CLAUSES[@]}"; do
  if dbq "SELECT LOCATE('$clause', JSON_UNQUOTE(JSON_EXTRACT(config,'\$.correction.scopeSummary'))) FROM execution_policies WHERE id='$PM_POLICY_ID';"; then
    hit="$(dbval)"
  else
    hit="query-failed"
  fi
  SCOPE_HITS="$SCOPE_HITS|$clause=$hit"
  [[ "$hit" =~ ^[1-9] ]] || SCHEMA_OK=0
done
log "PRE-1b execution_policies($PM_POLICY_ID).config.correction.scopeSummary hits:$SCOPE_HITS"

if [[ "$SCHEMA_OK" -ne 1 ]]; then
  fail "pre1-schema" "$(
    printf 'the two hand-written migrations are NOT applied on this stack: message_receipts.settled_reason missing, or the PM discipline text is not in the DB. The running image is STALE (server/Dockerfile bakes prisma/ and dist/ into the image, so a bare up -d keeps the old image). Mind that init carries its OWN image: rebuilding only server+web leaves vteam-init stale and migrate deploy then applies nothing. Fix: docker compose build server web init && docker rm -f %s && docker compose up -d && docker compose run --rm init. This run had E2E_REBUILD=%s.' "$INIT_CONTAINER" "$E2E_REBUILD")
  )"
fi
log "PRE-1b schema guard PASS (both migrations applied on this image)"

# ===========================================================================
# G 的对照基线（必须在 A..F **之前**取）
# ===========================================================================
# 为什么不按「绝对 0」断言：`pm_artifact_count` 统计的是 PM 提交的**全部**产出物，
# 其中包含 PM 职责内允许的「协调记录 / 核验结论」。团队跑过几轮真实任务后，库里必然
# 有这类记录，绝对值 0 就不再成立（本地实测：t_0000000007 的「流程与核验记录」被计入）。
# 因此这里只断言「**本次运行没有新增** PM 产出物」——这才是本脚本要证明的事。
api GET "/api/v1/teams/$TEAM_ID/coordination-metrics"
assert2xx "G-baseline"
G_PM_ART_BASE="$(python3 - "$API_OUT" <<'PYBASE'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); raise SystemExit(0)
for m in d.get("metrics") or []:
    if m.get("key") == "pm_artifact_count":
        print(m.get("value")); break
PYBASE
)"
[[ -n "$G_PM_ART_BASE" ]] || G_PM_ART_BASE=0
log "G 基线：本脚本运行前 pm_artifact_count=${G_PM_ART_BASE}（历史轮次留下的 PM 协调记录不计入本次断言）"

# ===========================================================================
# A · 迁移生效（真实库里看得到）
# ===========================================================================
# 断言来源：
#   - 列：server/prisma/migrations/20261022120000_receipt_settlement_reason/migration.sql
#     「ALTER TABLE message_receipts ADD COLUMN settled_reason varchar(191) NULL」
#   - 正文：server/prisma/migrations/20261022000000_pm_coordination_discipline/migration.sql
#     三条 UPDATE（agent_roles.role_prompt / execution_policies.config.correction.scopeSummary
#     / execution_policies.description）
A_FAILS=""
dbq "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='message_receipts' AND column_name='settled_reason';" || true
[[ "$(dbval)" == "1" ]] || A_FAILS="$A_FAILS A1(settled_reason 列缺失)"
for head_text in "${PM_DISCIPLINE_HEADS[@]}"; do
  dbq "SELECT LOCATE('$head_text', role_prompt) FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY';" || true
  hit="$(dbval)"
  [[ "$hit" =~ ^[1-9] ]] || A_FAILS="$A_FAILS A2(缺纪律条款:$head_text)"
done
for clause in "${PM_SCOPE_CLAUSES[@]}"; do
  dbq "SELECT LOCATE('$clause', JSON_UNQUOTE(JSON_EXTRACT(config,'\$.correction.scopeSummary'))) FROM execution_policies WHERE id='$PM_POLICY_ID';" || true
  hit="$(dbval)"
  [[ "$hit" =~ ^[1-9] ]] || A_FAILS="$A_FAILS A3(边界段缺条款:$clause)"
done
[[ -z "$A_FAILS" ]] || fail "A" "迁移生效断言失败:$A_FAILS"
# 顺手把两段正文原样打出来（mysql batch 模式会把换行转义成 \n，原样即可核对）
dbq "SELECT role_prompt FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY';" || true
log "A agent_roles($PM_ROLE_KEY).role_prompt = $(trunc "$DB_OUT" 700)"
dbq "SELECT JSON_UNQUOTE(JSON_EXTRACT(config,'\$.correction.scopeSummary')) FROM execution_policies WHERE id='$PM_POLICY_ID';" || true
log "A execution_policies($PM_POLICY_ID).scopeSummary = $(dbval)"
pass "A 两份手写迁移已在真实库生效（settled_reason 列 + PM 纪律正文 + 边界段）"

# ===========================================================================
# B · 派发返回值（真实 MCP 端点 → claimed / sessionStatus / triggered）
# ===========================================================================
# 断言来源：server/src/platform-mcp/platform-mcp.service.ts 的 NotifyAgentResult
#   「claimed（批次 A1）：平台已受理派发 且 目标存在可消费的活会话」
#   「sessionStatus（批次 A1）：目标团队会话状态；目标无会话行 → null」
#   「channelSwitched/channelSwitchReason（批次 A3）：团队维度被拦后自动改走了任务维度」
# 团队维度被 no-active-task 拦 ⇒ 自动改走任务维度 ⇒ channelSwitched='task'
B_TARGET="${E2E_B_TARGET:-tmm_0000000003}"   # 架构师-1
B_CONTENT="$RUN_ID B段派发：请确认收到本条（无需展开工作）"
B_ARGS="$(printf '{"teamId":"%s","selfInstanceId":"%s","targetInstanceId":"%s","content":"%s"}' \
  "$TEAM_ID" "$PM_MEMBER_ID" "$B_TARGET" "$B_CONTENT")"
mcp_call "notify_agent" "$B_ARGS" "B"
[[ "$MCP_CODE" == "200" ]] || fail "B" "platform-mcp HTTP $MCP_CODE body=$(trunc "$MCP_RAW" 300)"
if jget "$MCP_RESULT" 'd.get("_mcp_error")' | grep -q .; then
  fail "B" "MCP tools/call returned an error: $(trunc "$MCP_RESULT" 400)"
fi
B_TRIGGERED="$(notify_field "$MCP_RESULT" "triggered")"
B_CLAIMED="$(notify_field "$MCP_RESULT" "claimed")"
B_SESSION="$(notify_field "$MCP_RESULT" "sessionStatus")"
B_REASON="$(notify_field "$MCP_RESULT" "reason")"
B_MSGID="$(notify_field "$MCP_RESULT" "messageId")"
B_SWITCHED="$(notify_field "$MCP_RESULT" "channelSwitched")"
B_SWITCHREASON="$(notify_field "$MCP_RESULT" "channelSwitchReason")"
log "B notify_agent → triggered=$B_TRIGGERED claimed=$B_CLAIMED sessionStatus=$B_SESSION reason=$B_REASON messageId=$B_MSGID channelSwitched=$B_SWITCHED/$B_SWITCHREASON"
[[ "$B_TRIGGERED" == "true" || "$B_TRIGGERED" == "false" ]] \
  || fail "B" "notify_agent 返回里没有 triggered 字段（返回体=$(trunc "$MCP_RESULT" 400)）"
[[ "$B_CLAIMED" == "true" || "$B_CLAIMED" == "false" ]] \
  || fail "B" "notify_agent 返回里没有 claimed 字段（PR #59 的 A1 契约缺失；返回体=$(trunc "$MCP_RESULT" 400)）"
[[ "$B_SESSION" != "__MISSING__" ]] \
  || fail "B" "notify_agent 返回里没有 sessionStatus 字段（PR #59 的 A1 契约缺失；返回体=$(trunc "$MCP_RESULT" 400)）"
[[ "$B_TRIGGERED" == "true" ]] \
  || fail "B" "notify_agent 未真正投递（triggered=$B_TRIGGERED reason=${B_REASON}）——本段无法证明返回值契约"
[[ "$B_MSGID" != "__MISSING__" && "$B_MSGID" != "null" && -n "$B_MSGID" ]] \
  || fail "B" "notify_agent 没有返回 messageId（reason=$B_REASON hint=$(jget "$MCP_RESULT" 'd.get("hint")')）"
remember_message "$B_MSGID"
# B 段这次派发同样会在账本里记一行回执行（只减不增，但它**是**本次跑出来的 ⇒ 也要清理）
B_RECEIPT_ID=""
for _ in $(seq 1 10); do
  dbq "SELECT id FROM message_receipts WHERE message_id='$B_MSGID' LIMIT 1;" || true
  B_RECEIPT_ID="$(dbval)"
  if [[ -n "$B_RECEIPT_ID" ]]; then break; fi
  sleep 1
done
if [[ -n "$B_RECEIPT_ID" ]]; then
  remember_receipt "$B_RECEIPT_ID"
  log "B 本次派发产生的回执行 ${B_RECEIPT_ID}（cleanup 会删）"
fi
# A3：团队维度被 no-active-task 拦 ⇒ 自动改走任务维度（前提：团队确有 currentTaskId 且其状态非 in_progress）
dbq "SELECT COALESCE(t.current_task_id,''), COALESCE(k.status,'') FROM teams t LEFT JOIN tasks k ON k.id=t.current_task_id WHERE t.id='$TEAM_ID';" || true
CUR_TASK="$(dbval | cut -f1)"; CUR_TASK_STATUS="$(dbval | cut -f2)"
log "B team current_task_id=$CUR_TASK status=$CUR_TASK_STATUS"
if [[ -n "$CUR_TASK" && "$CUR_TASK_STATUS" != "in_progress" ]]; then
  [[ "$B_SWITCHED" == "task" && "$B_SWITCHREASON" == "no-active-task" ]] \
    || fail "B" "团队 currentTaskId=${CUR_TASK}（status=${CUR_TASK_STATUS}，非 in_progress ⇒ no-active-task 门应当拦下并自动改走任务维度）但返回 channelSwitched=$B_SWITCHED/${B_SWITCHREASON}（PR #59 的 A3 自动换道未生效）"
  log "B no-active-task 门自动改走任务维度：channelSwitched=task channelSwitchReason=no-active-task"
fi
pass "B notify_agent 经真实 MCP 端点返回 claimed/sessionStatus/triggered（triggered=$B_TRIGGERED claimed=$B_CLAIMED sessionStatus=${B_SESSION}）"

# ===========================================================================
# C · 引用即销账（群里精确引用派发 messageId ⇒ 回执行结账）
# ===========================================================================
# 断言来源：server/src/chat/message-receipts.service.ts
#   settleByReference：「正文**精确**引用了派发 messageId ⇒ 该派发的 pending 回执行结账」
#   settlePending(reason=quoted) → status='acked' + settled_reason='quoted'
#   （MESSAGE_RECEIPT_SETTLED_REASONS.quoted = 'quoted'，见 message-receipt.constants.ts）
C_TARGET="${E2E_C_TARGET:-tmm_0000000005}"   # 测试-1
C_CONTENT="$RUN_ID C段派发：请确认收到本条（无需展开工作）"
C_ARGS="$(printf '{"teamId":"%s","selfInstanceId":"%s","targetInstanceId":"%s","content":"%s"}' \
  "$TEAM_ID" "$PM_MEMBER_ID" "$C_TARGET" "$C_CONTENT")"
mcp_call "notify_agent" "$C_ARGS" "C-dispatch"
[[ "$MCP_CODE" == "200" ]] || fail "C" "platform-mcp HTTP $MCP_CODE"
[[ -z "$(jget "$MCP_RESULT" 'd.get("_mcp_error")')" ]] || fail "C" "MCP error: $(trunc "$MCP_RESULT" 300)"
C_MSGID="$(notify_field "$MCP_RESULT" "messageId")"
C_TRIGGERED="$(notify_field "$MCP_RESULT" "triggered")"
[[ "$C_TRIGGERED" == "true" && "$C_MSGID" != "__MISSING__" && "$C_MSGID" != "null" && -n "$C_MSGID" ]] \
  || fail "C" "C 段派发未落地（triggered=$C_TRIGGERED messageId=$C_MSGID reason=$(notify_field "$MCP_RESULT" "reason")）"
remember_message "$C_MSGID"
log "C 派发落地 messageId=$C_MSGID"
# 找到这条派发的回执行行
C_RECEIPT_ID=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  dbq "SELECT id FROM message_receipts WHERE message_id='$C_MSGID' LIMIT 1;" || true
  C_RECEIPT_ID="$(dbval)"
  if [[ -n "$C_RECEIPT_ID" ]]; then break; fi
  sleep 1
done
[[ -n "$C_RECEIPT_ID" ]] || fail "C" "派发 $C_MSGID 没有产生回执行行（message_receipts 里查不到）"
remember_receipt "$C_RECEIPT_ID"
dbq "SELECT status, COALESCE(settled_reason,'(null)') FROM message_receipts WHERE id='$C_RECEIPT_ID';" || true
log "C 回执行初始状态 = $(dbval)  (receipt=$C_RECEIPT_ID)"
# 群帖**精确引用**该 messageId（token 形如 m_0000000123，前后不得紧邻字母/数字/下划线）
C_TASK_ID="$CUR_TASK"
[[ -n "$C_TASK_ID" ]] || C_TASK_ID="${E2E_C_TASK_ID:-t_0000000001}"
C_POST_CONTENT="$RUN_ID 回执销账：引用派发 ${C_MSGID}，本条为对该派发的结账回复。"
C_POST_ARGS="$(printf '{"taskId":"%s","selfInstanceId":"%s","content":"%s"}' \
  "$C_TASK_ID" "$PM_MEMBER_ID" "$C_POST_CONTENT")"
mcp_call "group_post" "$C_POST_ARGS" "C-quote"
[[ "$MCP_CODE" == "200" ]] || fail "C" "platform-mcp (group_post) HTTP $MCP_CODE"
[[ -z "$(jget "$MCP_RESULT" 'd.get("_mcp_error")')" ]] || fail "C" "MCP error (group_post): $(trunc "$MCP_RESULT" 300)"
C_POST_ID="$(jget "$MCP_RESULT" 'd.get("messageId")')"
[[ -n "$C_POST_ID" && "$C_POST_ID" != "null" ]] || fail "C" "group_post 没有返回 messageId"
remember_message "$C_POST_ID"
log "C 群帖已发布 messageId=$C_POST_ID content=$C_POST_CONTENT"
# 结算在 group_post 落库后同步发生，但轮询一下更稳
C_STATUS=""; C_REASON=""
for _ in $(seq 1 20); do
  dbq "SELECT status, COALESCE(settled_reason,'(null)') FROM message_receipts WHERE id='$C_RECEIPT_ID';" || true
  C_STATUS="$(dbval | cut -f1)"; C_REASON="$(dbval | cut -f2)"
  if [[ "$C_STATUS" == "acked" ]]; then break; fi
  sleep 1
done
log "C 回执行结算后 = status=$C_STATUS settled_reason=$C_REASON"
[[ "$C_STATUS" == "acked" ]] \
  || fail "C" "引用派发 $C_MSGID 后回执行 $C_RECEIPT_ID 仍是 status=${C_STATUS}（期望 acked）——引用即销账未生效"
[[ "$C_REASON" == "quoted" ]] \
  || fail "C" "回执行 $C_RECEIPT_ID 的 settled_reason=${C_REASON}（期望 quoted）：结账依据不对，PR #61 的减法语义没落地"
pass "C 群帖精确引用 $C_MSGID ⇒ 回执行 $C_RECEIPT_ID 变 status=acked / settled_reason=quoted"

# ===========================================================================
# D · 催办分级（回执行到期 → 平台自动催办 → 真正发出去的文案必须是分级的）
# ===========================================================================
# 断言来源：server/src/chat/receipt-nudge.handler.ts
#   buildAutoNudgeText / buildNudgeDiagnosis 的四档措辞：
#     not-started        → 平台没有看到你的任何回复或产出物
#     delivered-unsettled→ 已经记到你的交付
#     receipt-not-landed → 查不到你的回执记录
#     unknown            → 未能确证当前态势
#   抬头（buildAutoNudgeText）：【平台自动催办·第1次】
#   落款（buildAutoNudgeText）：（原派发消息 <messageId>，receiptId=<receiptId>）
#   催办文案只经 workerDispatcher.dispatchAgentMention 发出（server 不落库、不打日志）
#   ⇒ 观测点是 worker 侧 opencode 会话里的 user 消息（worker_session_texts）。
#
# ---------------------------------------------------------------------------
# 为什么 D 段**不派发**（旧版失败的原因：实测，不是猜测）
# ---------------------------------------------------------------------------
#   旧版 D 段「派发一份 60s 内干不完的活」，期待目标来不及回执。活栈上每个成员会话都
#   健康（claimed=true / sessionStatus=running），成员**会**回执（stage=end）⇒ 回执行
#   被结掉（status=acked / settled_reason=answered）⇒ 到期时**没有 pending 回执行**
#   ⇒ 催办无对象。最近一次实跑的 6 次尝试全部如此（每次都记「回执行先被结掉：
#     status=acked settled_reason=answered」），历史上也有被到期清账抢先的情形。
#   那是**平台的正确行为**（有人回了执就不该催），是测试前提错了。
#
# 新版 D 段：**不派发**，直接种两行夹具（都在库里，脚本自建自删）：
#   ① message_receipts 一行 status='pending'
#      - 不派发 ⇒ 不唤醒任何 agent ⇒ 没人能回执 ⇒ 回执行必然保持 pending；
#      - message_id 指向 C 段那次**真实派发**的消息（notify_agent 落库的真消息）
#        ⇒ 文案里的「原派发消息 <id>」是真的（handler 的 classify 探针也要读它）；
#      - to_instance_id 指向一个**本轮没被唤醒**的空闲成员。
#   ② triggers 一行 kind='receipt_nudge'
#      - 催办的**触发器**是派发时由 platform-mcp.scheduleReceiptNudge 排的
#        （platform-mcp.service.ts：`dueAt = created.expiresAt`），
#        只种回执行**不会**触发催办 ⇒ 必须把触发器也种出来；
#      - dedup_key 用平台同一口径 buildTriggerDedupKey('receipt_nudge', teamId, receiptId)
#        = `receipt_nudge:<teamId>:<receiptId>`（common/constants/trigger.constants.ts）。
#
# 目标成员**不能**是团队主 Agent：handler 开头的 settleAnsweredQuestionReceiptsQuietly()
# （以及到期扫描里的同名补偿）会把「收件人是主 Agent」的 pending 回执行结掉
# （reason=question-answered）——主 Agent 在群里说过话就会命中 ⇒ 那类回执活不长。
# 该补偿扫的是**所有团队**的主 Agent ⇒ 候选查询按全局主 Agent 名册排除，不只看本团队。
#
# ---------------------------------------------------------------------------
# 两个 ticker 的节拍（compose 没覆盖这两个 env ⇒ 走缺省值）与 expires_at 的取法
# ---------------------------------------------------------------------------
#   催办触发器 ticker：TIMER_SCAN_INTERVAL_MS           缺省 30_000ms（timers/trigger.service.ts）
#   到期清账 ticker   ：RECEIPT_EXPIRY_SWEEP_INTERVAL_MS 缺省 60_000ms（chat/message-receipts.service.ts）
#   平台把两者设成**同一瞬间**（due_at == expires_at）。在 PR #68 之前，那一刻两个
#   ticker 同时醒、先到者赢 ⇒ 清账可能抢在催办前面把回执行判死，催办 handler 见
#   status≠pending 直接 done ⇒ 催办永远发不出去（本段当时只能靠把 expires_at 往后挪
#   90s 从外面绕过去才稳定观测到催办——那个绕行本身就是平台有病的 tell）。
#   PR #68 给到期清账加了 RECEIPT_EXPIRY_GRACE_MS(=60s) 宽限窗 ⇒ 清账判定线挪到
#   expires_at + 60s，而催办最迟在 due_at + 30s（一个 ticker 周期）发出 ⇒
#   **催办必然先赢**，不再需要任何外部绕行。
#   ⇒ 本段 D_EXPIRY_MARGIN_SEC 缺省 **0**（expires_at == due_at，完全贴平台真实形态）；
#      保留该旋钮只为在旧镜像/回归对比时能人为拉大间距。
#       代价：本段期间这行 pending 回执会算进主 Agent 的 fan-out 待回执计数
#       （countPendingFor），cleanup 段会删掉它。
D_NUDGE_DELAY_SEC="$E2E_D_NUDGE_DELAY_SEC"        # trigger due_at = now + 45s
D_EXPIRY_MARGIN_SEC="$E2E_D_EXPIRY_MARGIN_SEC"    # expires_at = due_at + 90s
D_TEXT_WAIT_SEC="$E2E_D_TEXT_WAIT_SEC"            # 催办文案出现在 worker 会话里的最长等待
D_RUN_TAG="$(printf '%s' "$RUN_ID" | tr -c 'A-Za-z0-9' '_')"

# 夹具引用的真实派发消息（C 段那次 notify_agent 落库的消息）
D_SRC_MESSAGE_ID="$C_MSGID"
dbq "SELECT channel_id FROM messages WHERE id='$D_SRC_MESSAGE_ID';" || true
D_SRC_CHANNEL_ID="$(dbval)"
[[ -n "$D_SRC_CHANNEL_ID" ]] \
  || fail "D" "找不到 C 段派发消息 $D_SRC_MESSAGE_ID 的 channel_id（它不在 messages 表里？C 段失败会被拦在这里）"

# ---- 目标成员：空闲 + 不在催办冷却期 + 不是主 Agent + 不是 B/C 段刚唤醒的人 ----
D_CANDIDATES=""
dbq "SELECT tm.id FROM team_members tm
      WHERE tm.team_id='$TEAM_ID'
        AND tm.id <> '$PM_MEMBER_ID'
        AND tm.id NOT IN (SELECT t2.main_agent_member_id FROM teams t2 WHERE t2.main_agent_member_id IS NOT NULL)
        AND tm.id NOT IN ('$B_TARGET','$C_TARGET')
        AND NOT EXISTS (SELECT 1 FROM message_receipts mr
                         WHERE mr.to_instance_id=tm.id
                           AND mr.last_nudged_at IS NOT NULL
                           AND mr.last_nudged_at >= DATE_SUB(NOW(3), INTERVAL 60 MINUTE))
        AND NOT EXISTS (SELECT 1 FROM sessions s
                         WHERE s.team_id='$TEAM_ID' AND s.team_member_id=tm.id
                           AND s.status IN ('running','active'))
      ORDER BY tm.id;" || true
while read -r mid; do
  [[ -n "$mid" ]] && D_CANDIDATES="$D_CANDIDATES $mid"
done < "$DB_OUT"
D_CANDIDATES="${D_CANDIDATES# }"
[[ -n "$D_CANDIDATES" ]] \
  || fail "D" "团队 $TEAM_ID 里没有可用于催办夹具的目标成员（都忙 / 都在催办冷却期 / 都是主 Agent / 都是 B、C 段刚唤醒的人）"
log "D 催办夹具候选目标（空闲 + 非冷却期 + 非主 Agent）：$D_CANDIDATES"

D_OK=0; D_CASE=""; D_NUDGE_TEXT=""; D_ATTEMPT_LOG=""
D_TARGET_USED=""; D_RECEIPT_USED=""; D_TRIGGER_USED=""
attempt=0
for target in $D_CANDIDATES; do
  [[ "$attempt" -lt "$E2E_NUDGE_ATTEMPTS" ]] || break
  attempt=$((attempt + 1))

  D_RECEIPT_ID="mr_e2e_${D_RUN_TAG}_a${attempt}"
  D_TRIGGER_ID="tmr_e2e_${D_RUN_TAG}_a${attempt}"
  D_TRIGGER_DEDUP="receipt_nudge:${TEAM_ID}:${D_RECEIPT_ID}"
  D_RECEIPT_DEDUP="e2e::${PM_MEMBER_ID}::${target}::${D_RECEIPT_ID}"

  # 显示名（催办文案里的「某 → 某：」两段）
  dbq "SELECT COALESCE(NULLIF(alias,''),id) FROM team_members WHERE id='$target';" || true
  D_TARGET_ALIAS="$(dbval)"
  dbq "SELECT COALESCE(NULLIF(alias,''),id) FROM team_members WHERE id='$PM_MEMBER_ID';" || true
  D_PM_ALIAS="$(dbval)"
  [[ -n "$D_TARGET_ALIAS" ]] || D_TARGET_ALIAS="$target"
  [[ -n "$D_PM_ALIAS" ]] || D_PM_ALIAS="$PM_MEMBER_ID"

  # 触发器 payload：字段名与 receipt-nudge.handler.ts 的 ReceiptNudgePayload 一一对应
  D_PAYLOAD_JSON="$(python3 - "$D_RECEIPT_ID" "$TEAM_ID" "$D_SRC_MESSAGE_ID" "$PM_MEMBER_ID" "$target" "$D_SRC_CHANNEL_ID" "$D_TARGET_ALIAS" "$D_PM_ALIAS" <<'DPAY_PY'
import json, sys
receipt_id, team_id, message_id, from_id, to_id, channel_id, assignee, from_name = sys.argv[1:9]
print(json.dumps({
    "receiptId": receipt_id,
    "teamId": team_id,
    "taskId": None,
    "channelId": channel_id,
    "messageId": message_id,
    "fromInstanceId": from_id,
    "toInstanceId": to_id,
    "assigneeName": assignee,
    "fromName": from_name,
}, ensure_ascii=False))
DPAY_PY
)"
  D_PAYLOAD_SQL="$(printf '%s' "$D_PAYLOAD_JSON" | sed "s/'/''/g")"

  # ① 种回执行（pending）——不派发 ⇒ 没人能回执 ⇒ 它必然保持 pending
  D_RC=0
  dbq "INSERT INTO message_receipts (id, message_id, from_instance_id, to_instance_id, task_id, team_id, summary, status, dedup_key, issue_id, nudge_count, last_nudged_at, expires_at, kind, force_reason, created_at, acked_at)
        VALUES ('$D_RECEIPT_ID', '$D_SRC_MESSAGE_ID', '$PM_MEMBER_ID', '$target', NULL, '$TEAM_ID', 'e2e 催办分级夹具（脚本自建自删）', 'pending', '$D_RECEIPT_DEDUP', NULL, 0, NULL, DATE_ADD(NOW(3), INTERVAL $((D_NUDGE_DELAY_SEC + D_EXPIRY_MARGIN_SEC)) SECOND), 'dispatch', NULL, NOW(3), NULL);" || D_RC=$?
  if [[ "$D_RC" -ne 0 ]]; then
    D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 回执行夹具插入失败：$(trunc "$DB_ERR" 160)"
    continue
  fi
  remember_receipt "$D_RECEIPT_ID"

  # ② 种催办触发器（receipt_nudge）——平台的排期口径见上
  D_RC=0
  dbq "INSERT INTO \`triggers\` (id, kind, status, payload, dedup_key, attempts, last_error, created_at, updated_at, due_at, scope_type, scope_id, owner_instance_id, interval_ms, next_fire_at, guard_key, fire_count, max_fires, expires_at, skip_reason, busy_retries)
        VALUES ('$D_TRIGGER_ID', 'receipt_nudge', 'pending', '$D_PAYLOAD_SQL', '$D_TRIGGER_DEDUP', 0, NULL, NOW(3), NOW(3), DATE_ADD(NOW(3), INTERVAL $D_NUDGE_DELAY_SEC SECOND), NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0);" || D_RC=$?
  if [[ "$D_RC" -ne 0 ]]; then
    D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 催办触发器插入失败：$(trunc "$DB_ERR" 160)"
    continue
  fi
  remember_trigger "$D_TRIGGER_ID"
  log "D #$attempt 已种夹具：回执行 ${D_RECEIPT_ID}（pending，expires_at=now+$((D_NUDGE_DELAY_SEC + D_EXPIRY_MARGIN_SEC))s）+ 催办触发器 ${D_TRIGGER_ID}（due_at=now+${D_NUDGE_DELAY_SEC}s）目标=${target}"

  # ③ 等催办：nudge_count>0 = 平台确实催办过（recordAutoNudge 落库）
  deadline=$(( $(date +%s) + E2E_NUDGE_WAIT_SEC ))
  fired=0; dstatus=""; dnudge=""; dreason=""; tstatus=""; tlasterr=""
  while [[ $(date +%s) -lt $deadline ]]; do
    dbq "SELECT r.status, r.nudge_count, COALESCE(r.settled_reason,'(null)'), COALESCE(t.status,'(no-trigger)'), COALESCE(t.last_error,'') FROM message_receipts r LEFT JOIN \`triggers\` t ON t.id='$D_TRIGGER_ID' WHERE r.id='$D_RECEIPT_ID';" || true
    dstatus="$(dbval | cut -f1)"; dnudge="$(dbval | cut -f2)"; dreason="$(dbval | cut -f3)"
    tstatus="$(dbval | cut -f4)"; tlasterr="$(dbval | cut -f5)"
    if [[ -n "$dnudge" && "$dnudge" != "0" ]]; then fired=1; break; fi
    if [[ "$tstatus" == "failed" ]]; then break; fi
    if [[ -n "$dstatus" && "$dstatus" != "pending" ]]; then break; fi
    sleep 2
  done
  if [[ "$fired" -ne 1 ]]; then
    if [[ "$tstatus" == "failed" ]]; then
      D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 催办触发器 failed：last_error=${tlasterr}"
    elif [[ -n "$dstatus" && "$dstatus" != "pending" ]]; then
      D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 回执行在催办之前就被结掉/清账（status=${dstatus} settled_reason=${dreason}），催办未发生"
    else
      D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 等待 ${E2E_NUDGE_WAIT_SEC}s 内催办未触发（trigger status=${tstatus} nudge_count=${dnudge}）"
    fi
    continue
  fi
  log "D #$attempt 催办已触发（nudge_count=${dnudge}，trigger status=${tstatus}，receipt status=${dstatus}）"

  # ④ 取目标成员的 opencode 会话：dispatchAgentMention 用的是 ensureTeamSession 建的
  #    **团队会话**（task_id IS NULL 那一行），催办文案就落在这个会话里
  sid=""
  for _ in $(seq 1 40); do
    dbq "SELECT COALESCE(instance_ref,'') FROM sessions WHERE team_id='$TEAM_ID' AND team_member_id='$target' AND task_id IS NULL AND instance_ref IS NOT NULL AND instance_ref <> '' AND instance_ref <> 'pending' ORDER BY created_at DESC LIMIT 1;" || true
    sid="$(dbval)"
    [[ -n "$sid" ]] && break
    sid=""
    sleep 2
  done
  if [[ -z "$sid" ]]; then
    D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 目标 $target 没有可读的 opencode 会话（sessions.instance_ref 为空或仍是 pending）"
    continue
  fi

  # ⑤ 在 worker 会话里找**本轮**催办文案（默认口径拉一次；找不到再按倒序拉一次，覆盖长会话）
  #
  # 用 receiptId 而不是「平台自动催办」做锚点：opencode 会话的转录**跨运行保留**
  # （脚本只删自己建的 messages 行，删不掉 worker 侧的会话史），所以上一次运行留下的
  # 催办文案会先被命中，落款里是**上一轮**的 receiptId ⇒ 断言的逐字落款必然不匹配。
  # receiptId 本轮唯一 ⇒ 只有本轮催办能命中。
  receipt_marker="receiptId=${D_RECEIPT_ID}"
  texts=""
  tdeadline=$(( $(date +%s) + D_TEXT_WAIT_SEC ))
  while [[ $(date +%s) -lt $tdeadline ]]; do
    texts="$(worker_session_texts "$sid")"
    if ! grep -qF "$receipt_marker" <<<"$texts"; then
      texts_desc="$(worker_session_texts "$sid" desc)"
      if grep -qF "$receipt_marker" <<<"$texts_desc"; then texts="$texts_desc"; fi
    fi
    if grep -qF "$receipt_marker" <<<"$texts"; then break; fi
    sleep 3
  done
  if ! grep -qF "$receipt_marker" <<<"$texts"; then
    D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt worker 会话（${sid}）里没找到本轮催办文案（${receipt_marker}）"
    continue
  fi
  D_NUDGE_TEXT="$(python3 - "$texts" "$D_RECEIPT_ID" <<'DSEG_PY'
import json, sys
try:
    arr = json.loads(sys.argv[1])
except Exception:
    arr = []
marker = "receiptId=" + sys.argv[2]
for t in arr:
    if marker in (t or ""):
        print(t)
        break
DSEG_PY
)"
  [[ -n "$D_NUDGE_TEXT" ]] || { D_ATTEMPT_LOG="$D_ATTEMPT_LOG; #$attempt 催办文案解析失败"; continue; }
  # 抬头 + 落款（原文）必须逐字命中
  grep -qF "$NUDGE_HEADER" <<<"$D_NUDGE_TEXT" \
    || fail "D" "催办文案缺少抬头 '$NUDGE_HEADER'（实际文案：$(trunc - 400 <<<"$D_NUDGE_TEXT")）"
  grep -qF "（原派发消息 ${D_SRC_MESSAGE_ID}，receiptId=${D_RECEIPT_ID}）" <<<"$D_NUDGE_TEXT" \
    || fail "D" "催办文案没有落款「（原派发消息 ${D_SRC_MESSAGE_ID}，receiptId=${D_RECEIPT_ID}）」（实际文案：$(trunc - 400 <<<"$D_NUDGE_TEXT")）"
  # 四档分级措辞至少命中一档
  D_CASE=""
  for c in "${GRADED_NUDGE_CASES[@]}"; do
    if grep -qF "$c" <<<"$D_NUDGE_TEXT"; then D_CASE="$c"; break; fi
  done
  [[ -n "$D_CASE" ]] \
    || fail "D" "催办文案不含任何一档分级措辞（期望其一：$(IFS=,; echo "${GRADED_NUDGE_CASES[*]}")）；实际文案：$(trunc - 400 <<<"$D_NUDGE_TEXT")）"
  D_OK=1
  D_TARGET_USED="$target"; D_RECEIPT_USED="$D_RECEIPT_ID"; D_TRIGGER_USED="$D_TRIGGER_ID"
  break
done
[[ "$D_OK" -eq 1 ]] || fail "D" "$(
  printf '回执超时催办在 %s 次尝试内都没观测到分级文案。每次尝试的原因：%s。' "$attempt" "$D_ATTEMPT_LOG"
)"
log "D 催办文案（真正发出去的原文）："
printf '%s\n' "$D_NUDGE_TEXT" > "$EVIDENCE_DIR/nudge-text.txt"
trunc "$EVIDENCE_DIR/nudge-text.txt" 900 | sed 's/^/[e2e] nudge| /' | tee -a "$E2E_LOG"
pass "D 回执到期后平台自动催办，文案落在分级档：'$D_CASE'（目标 ${D_TARGET_USED}，回执行 ${D_RECEIPT_USED}，触发器 ${D_TRIGGER_USED}）"

# ===========================================================================
# E · 纪律落库（岗位权威源 + 平台边界段）
# ===========================================================================
# 断言来源：server/src/common/constants/agent-role-prompts.constants.ts
#   （BUILTIN_ROLE_PROMPTS.project_manager 的四条纪律条目）
#   server/src/common/constants/agent.constants.ts
#   （ROLE_BOUNDARIES['vteam-project_manager'].scopeSummary 的主动委派条款）
E_FAILS=""
for head_text in "${PM_DISCIPLINE_HEADS[@]}"; do
  dbq "SELECT LOCATE('$head_text', role_prompt) FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY';" || true
  hit="$(dbval)"
  [[ "$hit" =~ ^[1-9] ]] || E_FAILS="$E_FAILS [缺:$head_text]"
done
for clause in "${PM_SCOPE_CLAUSES[@]}"; do
  dbq "SELECT LOCATE('$clause', JSON_UNQUOTE(JSON_EXTRACT(config,'\$.correction.scopeSummary'))) FROM execution_policies WHERE id='$PM_POLICY_ID';" || true
  hit="$(dbval)"
  [[ "$hit" =~ ^[1-9] ]] || E_FAILS="$E_FAILS [缺:$clause]"
done
# 纪律必须是**祈使句条目**（"- 纪律名：..."），不是身份陈述
dbq "SELECT COUNT(*) FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY' AND role_prompt LIKE '%- 【判定顺序·任何请求先过这一步】%' AND role_prompt LIKE '%- 【冲突裁决】%' AND role_prompt LIKE '%- 串行派活：%' AND role_prompt LIKE '%- 做完即停：%';" || true
if [[ "$(dbval)" != "1" ]]; then
  E_FAILS="$E_FAILS [四条纪律不是祈使句条目]"
fi
# 边界段必须仍是**单句**且不超长（越界拒绝话术每次都会插一遍）
dbq "SELECT CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(config,'\$.correction.scopeSummary'))) FROM execution_policies WHERE id='$PM_POLICY_ID';" || true
scope_len="$(dbval)"
[[ "$scope_len" =~ ^[0-9]+$ ]] || E_FAILS="$E_FAILS [scopeSummary 取不到]"
if [[ "$scope_len" =~ ^[0-9]+$ && "$scope_len" -gt 120 ]]; then
  E_FAILS="$E_FAILS [scopeSummary 长度 $scope_len > 120]"
fi
[[ -z "$E_FAILS" ]] || fail "E" "PM 纪律未落库:$E_FAILS"
dbq "SELECT JSON_UNQUOTE(JSON_EXTRACT(config,'\$.correction.scopeSummary')) FROM execution_policies WHERE id='$PM_POLICY_ID';" || true
log "E scopeSummary（长度 ${scope_len}）= $(dbval)"
pass "E PM 岗位定义四条纪律 + 平台边界段主动委派条款都在库里"

# ===========================================================================
# F · 权限未被收窄（能力矩阵键集 == 服务端目录，且没有一档被关掉）
# ===========================================================================
# 断言来源：
#   server/src/common/constants/platform-capability.constants.ts（PLATFORM_CAPABILITIES 目录）
#   server/src/prisma/role-capabilities-backfill.spec.ts
#     「内置 7 岗 / 外部 3 岗的键集必须**等于**目录键集——少一个键 = 该岗位静默获得该能力」
#   server/prisma/seed.ts 的 builtinRoleCapabilityMap：project_manager 显式全 true
CAP_SRC="$REPO_ROOT/server/src/common/constants/platform-capability.constants.ts"
[[ -f "$CAP_SRC" ]] || fail "F" "找不到能力目录源文件 ${CAP_SRC}（脚本必须对着真实目录断言）"
CAP_KEYS="$(sed -n "s/^    key: '\([^']*\)'.*/\1/p" "$CAP_SRC")"
CAP_COUNT="$(printf '%s' "$CAP_KEYS" | wc -w | tr -d ' ')"
[[ "$CAP_COUNT" -gt 0 ]] || fail "F" "从 $CAP_SRC 解析不出能力键"
log "F 能力目录键数=$CAP_COUNT : $CAP_KEYS"
dbq "SELECT JSON_KEYS(capabilities) FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY';" || true
CAP_JSON="$(cat "$DB_OUT")"
F_PY_RC=0
python3 - "$CAP_JSON" "$CAP_KEYS" "$PM_ROLE_KEY" <<'PY' 2>&1 | tee -a "$E2E_LOG" || F_PY_RC=1
import json, sys
try:
    db_keys = set(json.loads(sys.argv[1]) or [])
except Exception as e:
    print("F FAIL: 读不到 agent_roles.capabilities 的键集: %s" % e)
    raise SystemExit(1)
cat_keys = [k for k in (sys.argv[2] or "").split() if k]
missing = [k for k in cat_keys if k not in db_keys]
extra = sorted(db_keys - set(cat_keys))
if missing:
    print("F FAIL: capabilities 缺少目录键 %s（缺键=默认放行=静默扩权）" % missing)
    raise SystemExit(1)
if extra:
    print("F FAIL: capabilities 多了目录外的键 %s" % extra)
    raise SystemExit(1)
print("F 能力键集与目录完全相等（%d 个键，无缺无多）" % len(cat_keys))
PY
[[ "$F_PY_RC" == "0" ]] || fail "F" "能力键集断言失败（差异见上一行）"
# doc.submit 必须仍为 true（平台的硬约束：不收窄任何权限）
dbq "SELECT JSON_EXTRACT(capabilities,'\$.\"doc.submit\"') FROM agent_roles WHERE \`key\`='$PM_ROLE_KEY';" || true
DOC_SUBMIT="$(dbval)"
[[ "$DOC_SUBMIT" == "true" ]] \
  || fail "F" "PM 的 capabilities['doc.submit']=${DOC_SUBMIT}（期望 true）——权限被收窄了"
# PM 是显式全 true 岗位：不允许出现任何 false
dbq "SELECT COUNT(*) FROM agent_roles, JSON_TABLE(JSON_KEYS(capabilities),'\$[*]' COLUMNS(k VARCHAR(64) PATH '\$')) jt WHERE \`key\`='$PM_ROLE_KEY' AND JSON_EXTRACT(capabilities, CONCAT('\$.\"', jt.k, '\"')) IS NOT true;" || true
NOT_TRUE="$(dbval)"
[[ "$NOT_TRUE" == "0" ]] \
  || fail "F" "PM 的 capabilities 里有 $NOT_TRUE 个键不是 true（PM 出厂口径是显式全 true，PR #62 的硬约束是不收窄任何权限）"
pass "F PM 能力键集 == 服务端目录（$CAP_COUNT 个键），doc.submit 仍为 true，无一档被关"

# ===========================================================================
# G · 协调度指标（只读 admin 端点）
# ===========================================================================
# 断言来源：server/src/teams/coordination-metrics.service.ts
#   metric key 'pm_artifact_count'：PM 产出的产出物数，target {operator:'=',value:0}，ok = (value===0)
#   metric key 'pm_message_share'  ：PM 消息数 ÷ 全团队 agent 消息数（0..1 的比例）
#   端点：server/src/teams/coordination-metrics.controller.ts
#     GET /api/v1/teams/:teamId/coordination-metrics（AdminGuard，只读）
api GET "/api/v1/teams/$TEAM_ID/coordination-metrics"
assert2xx "G"
METRICS_JSON="$API_OUT"
METRICS_PRETTY="$EVIDENCE_DIR/coordination-metrics.json"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print(json.dumps(d, ensure_ascii=False, indent=2))' "$METRICS_JSON" >"$METRICS_PRETTY"
log "G 协调度指标原始响应（完整 JSON 存于 ${METRICS_PRETTY}）："
head -120 "$METRICS_PRETTY" | sed 's/^/[e2e] metrics| /' | tee -a "$E2E_LOG"
G_PY_RC=0
python3 - "$METRICS_JSON" "$G_PM_ART_BASE" <<'PY' 2>&1 | tee -a "$E2E_LOG" || G_PY_RC=1
import json, sys
d = json.load(open(sys.argv[1]))
base = int(sys.argv[2] or 0)
ms = {m.get("key"): m for m in (d.get("metrics") or [])}
art = ms.get("pm_artifact_count")
if art is None:
    print("G FAIL: 响应里没有 pm_artifact_count 指标（keys=%s）" % list(ms)); raise SystemExit(1)
# 只断言「本次运行没有新增」：历史轮次里 PM 提交的协调记录不应让本脚本失败。
if art.get("value") > base:
    print("G FAIL: PM 产出物数从 %d 涨到 %r（本次运行新增了 PM 产出物：PM 只做传话人/流程协调，不亲自交付）"
          % (base, art.get("value"))); raise SystemExit(1)
if art.get("target") != {"operator": "=", "value": 0}:
    print("G FAIL: pm_artifact_count 的 target = %r（期望 {'operator':'=','value':0}）" % art.get("target")); raise SystemExit(1)
share = ms.get("pm_message_share")
if share is None:
    print("G FAIL: 响应里没有 pm_message_share 指标（keys=%s）" % list(ms)); raise SystemExit(1)
v = share.get("value")
if not isinstance(v, (int, float)) or not (0.0 <= float(v) <= 1.0):
    print("G FAIL: PM 消息占比 = %r（期望 0..1 的比例）" % v); raise SystemExit(1)
# 「合理区间」：PM 是参与者不是唯一说话人（0 与 1 都是退化值）
if not (0.05 <= float(v) <= 0.95):
    print("G FAIL: PM 消息占比 = %r 落在退化区间外（合理区间 0.05..0.95）" % v); raise SystemExit(1)
det = share.get("detail") or {}
print("G pm_artifact_count=%r（基线 %d，本次未新增）；pm_message_share=%.4f（PM %s 条 / 全团队 %s 条）"
      % (art.get("value"), base, float(v), det.get("pmMessages"), det.get("totalAgentMessages")))
PY
[[ "$G_PY_RC" == "0" ]] || fail "G" "协调度指标断言失败（原因见上一行）"
pass "G 协调度指标端点可用：本次运行未新增 PM 产出物（基线 ${G_PM_ART_BASE}），PM 消息占比在合理区间"

# ===========================================================================
# 总结 —— 反跳过的守卫：重读原始日志
# ===========================================================================
for SEG in A B C D E F G; do
  grep -q "^\[e2e\] PASS $SEG " "$E2E_LOG" || fail "summary" "segment $SEG 在 $E2E_LOG 里没有 PASS 行——跳过或没跑的段永远不算通过"
done
log "----- assertions -----"
grep '^\[e2e\] PASS ' "$E2E_LOG" | sed 's/^/[e2e] /' | tee -a "$E2E_LOG"
log "all seven segments (A/B/C/D/E/F/G) PASS against the live stack; evidence: $E2E_LOG"
log "done"
