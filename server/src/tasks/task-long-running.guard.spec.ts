/**
 * 防回流守卫：`Task.longRunning` 的三处强制执行点与巡检注释的真实性。
 *
 * 背景（两类都会被单测漏掉的缺口）：
 *
 * 1. **三处 `select` 缺 `longRunning`**：巡检豁免的三个执行点都靠 Prisma `select`
 *    读出该列才能判定。而 `tasks.service.spec.ts` / `task-progression.scheduler.spec.ts`
 *    里的 Prisma 全是裸 `jest.Mock()`——无论 `select` 写什么都返回同一个固定对象。
 *    所以漏加字段时**所有单测照样全绿**，而线上门禁已死。本 spec 读源码补上这个洞。
 *
 * 2. **注释与行为脱节**：本文件曾有 5 处注释声称「periodic patrol 已退役 /
 *    fan-out JOIN drain 接管」，而 `triggers.schedule()` 一直在真实运行；另有一处
 *    「缺省 20min」与常量 10min 不符。这些错误会误导下一个改它的人把看门狗当死代码
 *    删掉。反向也要守：`:59` / `:107-109` 的「已退役」**是事实**（setInterval 内存
 *    循环确已退役、ticker 确为唯一节拍），不得为了让零命中断言通过而删掉。
 *
 * 若确需变更某条断言，请先确认它守护的不变量是否还成立——删断言这个动作本身就是
 * 设计评审的触发点（同 `plan-removal.guard.spec.ts` 的约定）。
 */
import * as fs from 'fs';
import * as path from 'path';

const TASKS_DIR = path.join(__dirname, '..', 'tasks');
const SCHEDULER = path.join(TASKS_DIR, 'task-progression.scheduler.ts');
const SERVICE = path.join(TASKS_DIR, 'tasks.service.ts');

const scheduler = () => fs.readFileSync(SCHEDULER, 'utf8');
const service = () => fs.readFileSync(SERVICE, 'utf8');

/** 取 `select: { ... }` 出现在 `anchor` 上下文之后的第一个 select 块。 */
function selectBlockAfter(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(-1);
  const slice = src.slice(at, at + 600);
  const m = /select:\s*\{([^}]*)\}/.exec(slice);
  expect(m).not.toBeNull();
  return m?.[1] ?? '';
}

describe('Task.longRunning 强制执行点（源码级）', () => {
  it('执行点 (a) register() 的 select 读出 longRunning', () => {
    const sel = selectBlockAfter(scheduler(), 'async register(taskId: string)');
    expect(sel).toMatch(/longRunning:\s*true/);
  });

  it('执行点 (b) handleProgressionFire() 的 select 读出 longRunning', () => {
    const sel = selectBlockAfter(scheduler(), 'async handleProgressionFire(');
    expect(sel).toMatch(/longRunning:\s*true/);
  });

  it('执行点 (b) 的门禁早于 runPatrol() 与 quietStreak++', () => {
    const src = scheduler();
    const at = src.indexOf('async handleProgressionFire(');
    const body = src.slice(at, at + 4000);
    const gate = body.indexOf('if ((task as any).longRunning)');
    expect(gate).toBeGreaterThan(-1);
    // 门禁必须落在「叫醒 agent」与「推进静默计数」两处之前，否则豁免形同虚设
    expect(gate).toBeLessThan(body.indexOf('this.runPatrol('));
    expect(gate).toBeLessThan(body.indexOf('this.readQuietStreak(ctx.payload) + 1'));
  });

  it('执行点 (c) systemBlock() 在 transition 之前有独立的 longRunning 前置查询', () => {
    const body = service().slice(
      service().indexOf('async systemBlock(id: string'),
      service().indexOf('async systemBlock(id: string') + 1200,
    );
    const gate = body.indexOf('longRunning');
    const transition = body.indexOf("this.transition(id, 'block'");
    expect(gate).toBeGreaterThan(-1);
    expect(transition).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(transition);
  });
});

describe('巡检注释与常量一致（源码级）', () => {
  it('真正错误的表述不得复活：fan-out JOIN drain 接管 / periodic patrol 退役 / 退役清扫', () => {
    for (const phrase of [
      'fan-out JOIN drain 接管',
      'periodic patrol 退役',
      '退役清扫',
    ]) {
      expect(scheduler()).not.toContain(phrase);
    }
  });

  it('每一处「缺省 Xmin」注释都与 DEFAULT_PROGRESSION_INTERVAL_MS 一致（10min）', () => {
    const expr = /DEFAULT_PROGRESSION_INTERVAL_MS = ([\d_]+) \* ([\d_]+);/.exec(
      scheduler(),
    );
    expect(expr).not.toBeNull();
    // 去掉数字分隔符再算：Number('60_000') 是 NaN
    const minutes =
      (Number((expr?.[1] ?? '').replace(/_/g, '')) *
        Number((expr?.[2] ?? '').replace(/_/g, ''))) /
      60_000;
    expect(minutes).toBe(10);

    for (const hit of scheduler().matchAll(/缺省\s*(\d+)\s*min/g)) {
      expect(Number(hit[1])).toBe(minutes);
    }
  });

  it('事实为真的「已退役」必须保留：setInterval 内存循环确已退役、ticker 确为唯一节拍', () => {
    // 反向守卫：消除这个字样会逼出新的错误注释（把 interval 行巡检也说成退役）
    expect(scheduler()).toContain('已退役');
  });
});
