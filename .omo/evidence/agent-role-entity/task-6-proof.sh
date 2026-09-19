#!/usr/bin/env bash
# agent-role-entity todo 6 — live HTTP proof against the rebuilt server container.
# Captures raw curl output for: list / create / update / patch-builtin / delete-builtin-403 / delete-custom.
set -uo pipefail

API="http://localhost:13000/api/v1"
EVID=".omo/evidence/agent-role-entity/task-6-api.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n===== %s =====\n' "$1"; }

say "LOGIN admin"
LOGIN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}')
echo "$LOGIN" | head -c 300; echo
TOKEN=$(printf '%s' "$LOGIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')
echo "token length: ${#TOKEN}"

say "GET /agent-roles (happy: 7 builtins)"
LIST=$(curl -s -w '\n__HTTP__%{http_code}' "$API/agent-roles" -H "Authorization: Bearer $TOKEN")
echo "$LIST" | head -c 4000; echo

say "GET /agent-roles?type=builtin"
LIST_B=$(curl -s -w '\n__HTTP__%{http_code}' "$API/agent-roles?type=builtin" -H "Authorization: Bearer $TOKEN")
echo "$LIST_B" | head -c 2500; echo

say "CREATE custom role"
CREATE=$(curl -s -w '\n__HTTP__%{http_code}' -X POST "$API/agent-roles" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"数据分析师","key":"data-analyst-task6","type":"custom","defaultAgentId":"a_developer","rolePrompt":"你是数据分析师，负责数据洞察。"}')
echo "$CREATE" | head -c 1200; echo
ROLE_ID=$(printf '%s' "$CREATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.replace(/\n__HTTP__\d+$/,""));console.log(j.id)})')
echo "created id: $ROLE_ID"

say "PATCH custom role (update name + rolePrompt)"
UPDATE=$(curl -s -w '\n__HTTP__%{http_code}' -X PATCH "$API/agent-roles/$ROLE_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"高级数据分析师","rolePrompt":"你是高级数据分析师，负责数据洞察与决策建议。"}')
echo "$UPDATE" | head -c 1200; echo

say "GET /agent-roles/:id (read back)"
GET_ONE=$(curl -s -w '\n__HTTP__%{http_code}' "$API/agent-roles/$ROLE_ID" -H "Authorization: Bearer $TOKEN")
echo "$GET_ONE" | head -c 1200; echo

say "PATCH builtin role ar_product (allowed: name/rolePrompt/defaultAgentId)"
PATCH_BUILTIN=$(curl -s -w '\n__HTTP__%{http_code}' -X PATCH "$API/agent-roles/ar_product" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rolePrompt":"__TASK6_PROBE__ 你是产品经理。"}')
echo "$PATCH_BUILTIN" | head -c 1000; echo

say "RESTORE builtin ar_product rolePrompt -> null"
RESTORE_BUILTIN=$(curl -s -w '\n__HTTP__%{http_code}' -X PATCH "$API/agent-roles/ar_product" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rolePrompt":null}')
echo "$RESTORE_BUILTIN" | head -c 1000; echo

say "PATCH builtin role key -> expect 403 AGENT_ROLE_BUILTIN_READONLY"
PATCH_BUILTIN_KEY=$(curl -s -w '\n__HTTP__%{http_code}' -X PATCH "$API/agent-roles/ar_product" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"product-v2"}')
echo "$PATCH_BUILTIN_KEY" | head -c 800; echo

say "DELETE builtin role ar_product (failure: expect 403 + row survives)"
DEL_BUILTIN=$(curl -s -w '\n__HTTP__%{http_code}' -X DELETE "$API/agent-roles/ar_product" \
  -H "Authorization: Bearer $TOKEN")
echo "$DEL_BUILTIN" | head -c 800; echo
SURVIVE=$(curl -s -w '\n__HTTP__%{http_code}' "$API/agent-roles/ar_product" -H "Authorization: Bearer $TOKEN")
echo "row survives GET:"; echo "$SURVIVE" | head -c 1000; echo

say "DELETE custom role (cleanup, expect success)"
DEL_CUSTOM=$(curl -s -w '\n__HTTP__%{http_code}' -X DELETE "$API/agent-roles/$ROLE_ID" \
  -H "Authorization: Bearer $TOKEN")
echo "$DEL_CUSTOM" | head -c 500; echo

say "DB row count check"
DBSURVIVE=$(docker exec aiagents-compose-db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" aiagents -N -e "SELECT COUNT(*) FROM agent_roles;"' 2>/dev/null)
DBPRODUCT=$(docker exec aiagents-compose-db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" aiagents -N -e "SELECT id, \`key\`, type, default_agent_id FROM agent_roles WHERE id=\"ar_product\";"' 2>/dev/null)
echo "count=$DBSURVIVE"; echo "ar_product row: $DBPRODUCT"

# --- assemble JSON evidence ---
node - "$EVID" "$LIST" "$LIST_B" "$CREATE" "$UPDATE" "$GET_ONE" "$PATCH_BUILTIN" \
  "$RESTORE_BUILTIN" "$PATCH_BUILTIN_KEY" "$DEL_BUILTIN" "$SURVIVE" "$DEL_CUSTOM" \
  "$DBSURVIVE" "$DBPRODUCT" <<'NODE'
const fs = require('fs');
const [evid, list, listB, create, update, getOne, patchBuiltin, restoreBuiltin,
  patchBuiltinKey, delBuiltin, survive, delCustom, dbCount, dbProduct] = process.argv.slice(2);
const split = (s) => { const m = s.match(/\n__HTTP__(\d+)\s*$/); return { http: m ? Number(m[1]) : null, body: m ? s.slice(0, m.index) : s }; };
const parse = (s) => { try { return JSON.parse(s.body); } catch { return s.body; } };
const out = {
  task: 'agent-role-entity todo 6 — AgentRole CRUD module + seed (API + builtin protection)',
  generatedAt: new Date().toISOString(),
  serverContainerRebuilt: true,
  endpoint: '/api/v1/agent-roles',
  permissionsReused: { read: ['agents.view'], create: ['agents.create'], update: ['agents.edit'], delete: ['agents.delete'] },
  builtinProtectionCode: 'AGENT_ROLE_BUILTIN_READONLY',
  steps: [
    { name: 'list', raw: split(list) },
    { name: 'list?type=builtin', raw: split(listB) },
    { name: 'create-custom', raw: split(create), parsed: parse(split(create)) },
    { name: 'update-custom', raw: split(update), parsed: parse(split(update)) },
    { name: 'get-custom', raw: split(getOne), parsed: parse(split(getOne)) },
    { name: 'patch-builtin-rolePrompt', raw: split(patchBuiltin) },
    { name: 'restore-builtin-rolePrompt-null', raw: split(restoreBuiltin) },
    { name: 'patch-builtin-key-403', raw: split(patchBuiltinKey) },
    { name: 'delete-builtin-403', raw: split(delBuiltin) },
    { name: 'builtin-row-survives', raw: split(survive) },
    { name: 'delete-custom-cleanup', raw: split(delCustom) },
  ],
  db: { rowCountAfterAll: dbCount.trim(), arProductRow: dbProduct.trim() },
};
fs.writeFileSync(evid, JSON.stringify(out, null, 2));
console.log('evidence written:', evid);
NODE
