# Task 3 - 端口处理记录

## 问题
默认端口 3000 已被占用，导致无法直接启动服务。

## 占用详情
```
PORT   PROCESS
3000   LISTEN 0.0.0.0:3000  users:(("node",pid=1706736,fd=22))
```
占用进程命令：`node --experimental-strip-types src/server/index.ts`（aiagents/web 前端 dev server）。

## 处理方式
- 未 kill 占用进程（属于 web 前端，非本任务范围）。
- 通过环境变量 `PORT=3001` 启动 NestJS 服务。
- `main.ts` 已实现 `process.env.PORT ?? 3000`，支持端口注入。

## 验证
```
PORT=3001 npm run start
curl localhost:3001/api/v1/health   → 200 {"status":"ok"}
```
验证完成后已释放 3001 端口（kill 进程 pid=2372866）。

## 智慧沉淀
- 端口占用时优先使用 `PORT` env 重试，而非强制 kill 其他服务。
- `main.ts` 读取 `process.env.PORT ?? 3000`，保证可移植性。