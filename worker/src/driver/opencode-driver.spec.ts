/**
 * 接缝边界守卫 + 接口形状断言（计划 T8）。
 *
 * 守卫的意义：`OpenCodeDriver` 的价值全在「上游类型不越过这条边界」。一旦有人图省事
 * 在接口里写上游的类型名（Session.Info / Content[] / Permission.Request …），下一版契约
 * 变更就会顺着接口渗进业务层——接缝静默失效。故用**源码级断言**把这条边界钉死。
 */

import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeDriver } from './opencode-driver';

/** 禁止出现在接口文件里的上游类型字面量（正则）。 */
const FORBIDDEN_TYPE_LITERALS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /Session\.Info/, why: '上游会话类型' },
  { pattern: /Session\.Message/, why: '上游消息类型' },
  { pattern: /Session\.Inbox/, why: '上游收件箱类型' },
  { pattern: /Agent\.Info/, why: '上游 agent 类型' },
  { pattern: /Model\.Info/, why: '上游模型类型' },
  { pattern: /Permission\.Request/, why: '上游权限类型' },
  { pattern: /Form\./, why: '上游表单类型' },
  { pattern: /(?<![A-Za-z0-9_])Prompt\./, why: '上游提示类型' },
  { pattern: /(?<![A-Za-z0-9_])Content\[\]/, why: '上游内容数组类型' },
  { pattern: /(?<![A-Za-z0-9_])Part(\[\])?(?![A-Za-z0-9_])/, why: '上游内容单元类型' },
  { pattern: /@opencode-ai\/sdk|@opencode\/sdk/, why: '上游 SDK 依赖' },
];

/** 接口文件源码（相对本文件同目录）。 */
function readInterfaceSource(): string {
  return fs.readFileSync(path.join(__dirname, 'opencode-driver.ts'), 'utf8');
}

describe('接缝边界守卫（接口文件不得含上游类型字面量）', () => {
  it('接口文件不含任何上游类型字面量', () => {
    const source = readInterfaceSource();
    const hits = FORBIDDEN_TYPE_LITERALS.filter(({ pattern }) => pattern.test(source)).map(
      ({ pattern, why }) => `${pattern}（${why}）`,
    );
    expect(hits).toEqual([]);
  });

  it('接口文件不依赖任何具体实现（不得 import v1-driver）', () => {
    const source = readInterfaceSource();
    expect(source).not.toMatch(/from\s+'\.\/v1-driver'/);
  });

  it('接口文件只依赖 vteam 自己的协议模块（不引入上游包）', () => {
    const source = readInterfaceSource();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec.startsWith('.')).toBe(true);
      expect(spec).not.toMatch(/opencode-ai|@opencode/);
    }
  });
});

/** 接口上的方法键（过滤掉 baseUrl / authPassword 等属性）。 */
type DriverFunctionKeys = {
  [K in keyof OpenCodeDriver]: OpenCodeDriver[K] extends (...args: never[]) => unknown ? K : never;
}[keyof OpenCodeDriver];

/** 业务层（exec-server / index / prompt-await）实际调用的全部驱动方法。 */
const CALLED_METHODS: DriverFunctionKeys[] = [
  'createSession',
  'sendMessage',
  'getMessages',
  'listQuestions',
  'replyQuestion',
  'rejectQuestion',
  'listPermissions',
  'replyPermission',
  'abort',
  'listAgents',
  'listTodos',
  'listModels',
  'isHealthy',
];

describe('接口形状（业务层调用点全覆盖）', () => {
  it('接口暴露业务层调用的全部方法（编译期 + 运行期双断言）', () => {
    // 编译期：数组元素类型受 DriverFunctionKeys 约束——名字写错/不是方法 → 编译失败。
    expect(CALLED_METHODS).toHaveLength(13);
    expect(new Set(CALLED_METHODS).size).toBe(CALLED_METHODS.length);
  });

  it('接口暴露 baseUrl（可写）与 authPassword（只读）', () => {
    const driver: Pick<OpenCodeDriver, 'baseUrl' | 'authPassword'> = {
      baseUrl: 'http://127.0.0.1:4199',
      authPassword: '',
    };
    expect(driver.baseUrl).toBe('http://127.0.0.1:4199');
    expect(driver.authPassword).toBe('');
  });
});
