/**
 * 能力点目录往返一致性断言（issue is_0000000009）
 * =================================================
 * 背景：web 端的「角色」Tab 渲染的是**前端硬编码副本**
 * `web/src/api/role-capabilities.ts`（服务端未暴露目录接口，副本是该文件自述的既定形态）。
 * 该副本此前与服务端 `PLATFORM_CAPABILITIES` 漂移 4 个键，且 `web/` 下**没有任何测试**
 * 引用它 —— 漂移不会被任何测试发现。本次即活证据。
 *
 * 本断言读取**源码文本**而非 import：web 不在 server 的 tsconfig 路径内，
 * 且 `web/` 无单元测试基建（见 PR #36 说明）。
 *
 * 覆盖两向：
 * - 少同步：副本缺服务端有的键（本缺陷的实际方向）
 * - 多同步：副本有服务端没有的键（会渲染出关不掉的幽灵开关）
 * 并逐字段核对 label / tools / 出厂拒绝，避免「键在但语义已漂」。
 */

import * as fs from 'fs';
import * as path from 'path';

import { PLATFORM_CAPABILITIES } from '../common/constants/platform-capability.constants';

type Cap = {
  key: string;
  label: string;
  tools: string[];
  factoryDefault: boolean;
};

const WEB_COPY = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'web',
  'src',
  'api',
  'role-capabilities.ts',
);

/** web 无单元测试基建；仓库裁剪/CI 省略 web 时跳过而非误报失败。 */
const hasWebCopy = fs.existsSync(WEB_COPY);
const describeIfWeb = hasWebCopy ? describe : describe.skip;

const slice = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0)
    throw new Error(`无法从 web 副本切出 ${from} … ${to}`);
  return text.slice(start, end);
};

const readTools = (raw: string): string[] =>
  [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/**
 * 解析前端副本。按 `key: "…"` 出现位置切段，因此**与书写风格无关**：
 * 单行 `{ … },` 与多行展开两种写法都能解析（该文件未纳入 prettier 格式化，
 * 任何人手工重排都不应让本断言失效或漏解析）。
 */
const readWebCopy = (): Cap[] => {
  const body = slice(
    fs.readFileSync(WEB_COPY, 'utf8'),
    'export const ROLE_CAPABILITIES',
    '] as const',
  );

  const marks = [...body.matchAll(/key:\s*"([^"]+)"/g)];
  return marks.map((m, i) => {
    const seg = body.slice(m.index, marks[i + 1]?.index ?? body.length);
    const tools = /tools:\s*\[([\s\S]*?)\]/.exec(seg);
    return {
      key: m[1],
      label: /label:\s*"([^"]+)"/.exec(seg)?.[1] ?? '',
      tools: tools ? readTools(tools[1]) : [],
      factoryDefault: /factoryDefault:\s*true/.test(seg),
    };
  });
};

const server = PLATFORM_CAPABILITIES.map((c) => ({
  key: c.key,
  label: c.label,
  tools: [...c.tools],
  factoryDefault: !c.defaultDeny,
}));

describe('能力点目录：服务端 ↔ web 副本往返一致（is_0000000009）', () => {
  it('web 副本可解析且非空（守卫自身有效性）', () => {
    expect(hasWebCopy).toBe(true);
    expect(readWebCopy().length).toBeGreaterThan(0);
  });

  describeIfWeb('逐键一致', () => {
    const web = readWebCopy();

    it('键集合逐项相等（两向）', () => {
      const webKeys = web.map((c) => c.key);
      const serverKeys = server.map((c) => c.key);
      const missingInWeb = serverKeys.filter((k) => !webKeys.includes(k));
      const extraInWeb = webKeys.filter((k) => !serverKeys.includes(k));
      expect({ missingInWeb, extraInWeb }).toEqual({
        missingInWeb: [],
        extraInWeb: [],
      });
    });

    it('逐字段相等：label / tools / 出厂拒绝', () => {
      const byKey = new Map(web.map((c) => [c.key, c]));
      const drift: string[] = [];
      for (const s of server) {
        const w = byKey.get(s.key);
        if (!w) continue;
        if (
          w.label.replace(/（执行点待上线，当前不产生拦截）$/, '') !== s.label
        ) {
          drift.push(`${s.key} label: ${s.label} ≠ ${w.label}`);
        }
        if (w.tools.join() !== s.tools.join()) {
          drift.push(`${s.key} tools: ${s.tools} ≠ ${w.tools}`);
        }
        if (w.factoryDefault !== s.factoryDefault) {
          drift.push(
            `${s.key} factoryDefault: ${s.factoryDefault} ≠ ${w.factoryDefault}`,
          );
        }
      }
      expect(drift).toEqual([]);
    });
  });
});
