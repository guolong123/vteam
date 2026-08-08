# Task 6: 后端测试基座（jest + supertest）

## 目标
在 `server/` 配置 jest（ts-jest + supertest + @nestjs/testing），建立单测与 e2e 测试基座，测试环境使用 sqlite 测试库，不依赖 MySQL。

## 交付物

| 文件 | 说明 |
|------|------|
| `server/jest.config.js` | 单测 jest 配置（ts-jest 转换 TS、`rootDir: src`、`setupFiles` 注入 sqlite 测试库） |
| `server/test/setup-env.js` | 测试环境变量：`DATABASE_URL=file:./test.db`、`DB_TYPE=sqlite` |
| `server/test/jest-e2e.json` | e2e 配置（脚手架已有，保留） |
| `server/test/app.e2e-spec.ts` | 示例 e2e 测试（supertest 验证 GET / → Hello World!） |
| `server/package.json` | `"test": "jest --runInBand"`；移除内联 jest 块（迁移至 jest.config.js） |

## 测试基座能力
- **单测**：`npm run test` → `jest --runInBand`，`rootDir=src`，匹配 `*.spec.ts`，ts-jest 转换 TS。
- **e2e**：`npm run test:e2e` → `jest --config ./test/jest-e2e.json`，@nestjs/testing + supertest。
- **DI 支持**：@nestjs/testing 的 `Test.createTestingModule` 编译模块，示例测试覆盖 AppController + AppService。
- **sqlite 测试库**：`test/setup-env.js` 在用例执行前注入 `DATABASE_URL=file:./test.db`，保证测试不依赖 MySQL。

## 验证结果

### 单测 `npm run test`
```
PASS src/app.controller.spec.ts
  AppController
    root
      ✓ should return "Hello World!" (13 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
```
退出码 0。

### e2e `npm run test:e2e`
```
PASS test/app.e2e-spec.ts
  AppController (e2e)
    ✓ / (GET) (188 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
```
退出码 0。

## 结论
后端测试基座已就绪：jest + ts-jest + supertest + @nestjs/testing 全部可用，单测与 e2e 均通过，测试环境统一使用 sqlite 测试库，不依赖 MySQL。业务测试留待 Task 15-17 各自添加。