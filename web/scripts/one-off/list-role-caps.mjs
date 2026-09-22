// 一次性脚本：列出 agent-roles 的 capabilities 状态（只读，不改数据）
const base = "http://localhost:13000/api/v1";
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin123" }),
});
const tok = (await login.json()).accessToken;
if (!tok) {
  console.error("login failed", login.status, await login.text());
  process.exit(1);
}
const res = await fetch(`${base}/agent-roles`, { headers: { Authorization: `Bearer ${tok}` } });
const body = await res.json();
const roles = Array.isArray(body) ? body : body.items ?? body.roles ?? body.data ?? [];
for (const r of roles) {
  const caps = r.capabilities === null ? "NULL (factory default)" : `saved map, ${Object.keys(r.capabilities).length} keys, denied=${Object.values(r.capabilities).filter((v) => v === false).length}`;
  console.log(`${r.id} | key=${r.key} | type=${r.type} | name=${r.name} | ${caps}`);
}
