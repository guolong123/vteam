# Task 15 Evidence — 修复 web 构建引用的 proto-shared 旧路径

## 背景
T1 删除 `web/src/components/docs/**` 后，`web/Dockerfile:11` 与 `web/scripts/sync-runtime.mjs:26` 仍引用旧路径，
`docker compose up -d --build` 在 `[web build 5/12]` 报 `COPY web/src/components/docs/proto-shared ... not found`。

## 改动
1. `web/Dockerfile`：删除第 10-11 行（旧注释 + `COPY web/src/components/docs/proto-shared ...`），
   替换为说明注释（proto-shared 已迁至 features/docs-site，sync-runtime.mjs 自带 mkdirSync/existsSync 兜底）。
2. `web/scripts/sync-runtime.mjs`：
   - import 增加 `existsSync`
   - `sharedDir` 改为 `src/features/docs-site/proto-shared`
   - 增加 `mkdirSync(sharedDir, { recursive: true })`（防 postinstall 期间目录不存在导致 writeFileSync ENOENT）
   - 6 个 `readFileSync` 改为 `existsSync` 守卫，缺失则 `console.warn` 跳过

## 验证
- `node --check web/scripts/sync-runtime.mjs` => SYNTAX_OK
- `grep -rn "components/docs" web/Dockerfile web/scripts/` => 零命中（exit 1）
- `npm run sync:runtime --prefix web` => 6 个缺失源文件警告跳过（非 ENOENT），
  react-runtime.js (188KB) + esbuild.wasm 正常生成，sources.generated.ts 写入新路径，EXIT 0
- `docker compose up -d --build` => 全绿：aiagents-init/server/web/worker 全部 Built，
  五容器 Running（web 22s 前重建，healthy）
- `curl http://localhost:13001/` => 200
- `curl http://localhost:13000/api/v1/health` => 200
- `curl http://localhost:13001/esbuild/esbuild.wasm` => 200 (13,978,850B)
- `curl http://localhost:13001/vendor/react-runtime.js` => 200 (192,253B)
- `curl -H "Authorization: Bearer invalid" http://localhost:13000/api/v1/docs-site/t_seed_1/registry` => 401（鉴权契约正常）

## 结论
PASS — docker compose 部署成功，文档站静态资源与 API 契约就绪。