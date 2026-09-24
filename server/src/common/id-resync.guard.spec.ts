import * as fs from 'fs';
import * as path from 'path';

/**
 * 防回归守卫：IdGeneratorService 前缀必须有启动期 resync 对齐。
 *
 * 背景（2026-09-16 线上事故）：`tmr_` 前缀缺 resync，服务重启后计数器归零，
 * `TriggerService.schedule()` 的 create 撞既有主键 P2002；而调用方把 P2002
 * 误判为「去重冲突」静默跳过 → 自动催办 timer 全部消失、永不触发。
 * 同一类 bug 本会话已复发三次（pl_ / mr_ / tmr_），故以源码级断言固化：
 * **凡 `nextId(<prefix>)` 的生成点，必须有对应 `resyncIdPrefix(..., <prefix>, ...)`。**
 *
 * 豁免：realtime 事件前缀（ev/ec）自带 P2002 自愈重试（realtime.service.ts
 * isPrimaryConflict + reseedFromDb），不依赖启动期对齐——豁免项须逐条注明理由。
 *
 * 断言范围：仅扫描生产源码（排除 *.spec.ts 与本文件自身）。
 */

const SRC_ROOT = path.join(__dirname, '..');

/** 豁免前缀 → 理由（每条必须说明为何无需启动期 resync）。 */
const RESYNC_EXEMPT: Record<string, string> = {
  ev: 'realtime 事件自带 P2002 自愈重试（realtime.service.ts isPrimaryConflict/reseedFromDb）',
  que: '仅用于生成 requestId 字符串（que_platform_<seq>），非任何表主键，无主键冲突风险',
};

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

/** 常量表：形如 `export const FOO_ID_PREFIX = 'ab'`（含 `as const` / 类型注解）。 */
function buildConstantMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    // 单值常量：const FOO_ID_PREFIX = 'ab'
    const re =
      /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      map.set(m[1], m[2]);
    }
    // 对象字面量常量：const ID_PREFIX = { session: 's', taskEvent: 'te', ... }
    const objRe =
      /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(text)) !== null) {
      const objName = om[1];
      const body = om[2];
      const kvRe = /(\w+)\s*:\s*'([^']+)'/g;
      let kv: RegExpExecArray | null;
      while ((kv = kvRe.exec(body)) !== null) {
        map.set(`${objName}.${kv[1]}`, kv[2]);
      }
    }
  }
  return map;
}

/** 解析实参为前缀字符串：字面量直取；标识符查常量表；`.replace(/_$/,'')` 去尾斜杠。 */
function resolvePrefix(
  raw: string,
  constants: Map<string, string>,
): string | null {
  const trimmed = raw
    .trim()
    .replace(/\/\/.*$/, '')
    .trim();
  const literal = /^'([^']*)'$/.exec(trimmed);
  if (literal) return literal[1];
  // 对象成员：ID_PREFIX.session
  const member = /^([A-Z][A-Z0-9_]*)\.(\w+)$/.exec(trimmed);
  if (member) return constants.get(`${member[1]}.${member[2]}`) ?? null;
  const ident = /^([A-Z][A-Z0-9_]*)$/.exec(trimmed);
  if (ident) return constants.get(ident[1]) ?? null;
  // 常量 + .replace(/_$/, '')：常量值可能是 'nc_'
  const withReplace = /^([A-Z][A-Z0-9_]*)\s*\.replace\(/.exec(trimmed);
  if (withReplace) {
    const base = constants.get(withReplace[1]);
    return base === undefined ? null : base.replace(/_$/, '');
  }
  return null;
}

/** 收集某函数调用的首个实参文本（支持括号内嵌套一层）。 */
function collectCallArgs(
  text: string,
  callee: string,
): Array<{ file: string; line: number; arg: string }> {
  const out: Array<{ file: string; line: number; arg: string }> = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    const at = line.indexOf(`${callee}(`);
    if (at === -1) return;
    let depth = 0;
    let arg = '';
    for (let i = at + callee.length + 1; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') depth++;
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      if (ch === ',' && depth === 0) break;
      arg += ch;
    }
    out.push({ file: '', line: idx + 1, arg });
  });
  return out;
}

describe('防回归：IdGeneratorService 前缀须有启动期 resync', () => {
  const constants = buildConstantMap();

  it('每个 nextId 生成点都有对应 resyncIdPrefix（豁免须逐条注明理由）', () => {
    const generated = new Map<string, string[]>();
    const resynced = new Set<string>();

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      const text = fs.readFileSync(file, 'utf8');

      for (const hit of collectCallArgs(text, 'nextId')) {
        const prefix = resolvePrefix(hit.arg, constants);
        if (prefix === null) continue;
        const list = generated.get(prefix) ?? [];
        list.push(`${rel}:${hit.line}`);
        generated.set(prefix, list);
      }
      for (const hit of collectCallArgs(text, 'resyncIdPrefix')) {
        // resyncIdPrefix(model, PREFIX, idGen)：首个逗号前的实参是 model，需取第二个。
        const secondArg = hit.arg; // collectCallArgs 只取到首个逗号（即 model）
        void secondArg;
      }
      // resync 的第二实参需单独解析：按行取 `resyncIdPrefix(` 后第一个逗号到第二个逗号之间。
      const re = /resyncIdPrefix\(\s*[^,]+,\s*([^,]+),/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const prefix = resolvePrefix(m[1], constants);
        if (prefix !== null) resynced.add(prefix);
      }
    }

    const missing: string[] = [];
    for (const [prefix, sites] of generated) {
      if (resynced.has(prefix)) continue;
      if (RESYNC_EXEMPT[prefix]) continue;
      missing.push(`前缀 '${prefix}' 缺失 resync，生成点：${sites.join(', ')}`);
    }

    expect(missing).toEqual([]);
  });

  it('豁免表非空时每条必须带理由（防无脑加豁免绕过守卫）', () => {
    for (const [prefix, reason] of Object.entries(RESYNC_EXEMPT)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(typeof prefix).toBe('string');
    }
  });

  it('已知关键前缀均已 resync（tmr/mr/pl 三例事故的固化）', () => {
    const resynced = new Set<string>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /resyncIdPrefix\(\s*[^,]+,\s*([^,]+),/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const prefix = resolvePrefix(m[1], constants);
        if (prefix !== null) resynced.add(prefix);
      }
    }
    for (const p of ['tmr', 'mr', 'pl']) {
      expect(resynced.has(p)).toBe(true);
    }
  });
});
