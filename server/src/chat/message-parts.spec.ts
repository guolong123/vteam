import {
  INJECTED_PROMPT_MARKERS,
  isInjectedPromptPart,
  mergePartsById,
  stripInjectedPromptParts,
} from './message-parts';

describe('注入提示 part 识别 / 剔除（isInjectedPromptPart / stripInjectedPromptParts）', () => {
  it('三个精确标记开头（后接用户原文）→ 命中', () => {
    for (const marker of INJECTED_PROMPT_MARKERS) {
      expect(
        isInjectedPromptPart({ type: 'text', text: `${marker}用户的原始文本` }),
      ).toBe(true);
    }
  });

  it('标记前有空白 → 仍命中（trim 后以标记开头）', () => {
    expect(
      isInjectedPromptPart({
        type: 'text',
        text: '  \n【任务上下文】你的当前任务 ID：t_1。',
      }),
    ).toBe(true);
  });

  it('true-negative：相似但非精确标记（【重要】）→ 不命中', () => {
    expect(
      isInjectedPromptPart({ type: 'text', text: '【重要】这是一条普通正文' }),
    ).toBe(false);
  });

  it('true-negative：标记出现在文本中段（非开头）→ 不命中', () => {
    expect(
      isInjectedPromptPart({
        type: 'text',
        text: '上文【任务上下文】不是前缀',
      }),
    ).toBe(false);
  });

  it('true-negative：非 text 类型即便文本以标记开头 → 不命中', () => {
    expect(
      isInjectedPromptPart({ type: 'reasoning', text: '【任务上下文】x' }),
    ).toBe(false);
  });

  it('true-negative：空/缺失 text → 不命中', () => {
    expect(isInjectedPromptPart({ type: 'text' })).toBe(false);
    expect(isInjectedPromptPart({ type: 'text', text: '   ' })).toBe(false);
  });

  it('stripInjectedPromptParts：剔除注入 part、保留正常 part 且顺序不变', () => {
    const normal = { type: 'text', text: '结论如下', synthetic: false };
    const injected = { type: 'text', text: '【群聊回复要求】请在群聊回复' };
    const reasoning = { type: 'reasoning', text: '思考' };
    expect(stripInjectedPromptParts([injected, reasoning, normal])).toEqual([
      reasoning,
      normal,
    ]);
  });

  it('stripInjectedPromptParts：非数组 → []；剔除 null/非对象条目', () => {
    expect(stripInjectedPromptParts(undefined)).toEqual([]);
    expect(stripInjectedPromptParts('x')).toEqual([]);
    expect(
      stripInjectedPromptParts([null, 1, { type: 'text', text: 'ok' }]),
    ).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('mergePartsById 流式单调守卫（monotonicText）', () => {
  const text = (id: string, body: string) => ({ id, type: 'text', text: body });

  it('默认（不开启）保持 last-write-wins：更短快照照样覆盖（回归原语义）', () => {
    const merged = mergePartsById([text('p1', 'hello world')], [text('p1', 'hi')]);
    expect(merged).toEqual([text('p1', 'hi')]);
  });

  it('开启后：同 id 更短文本快照被丢弃，保留更长旧快照（防渲染回退）', () => {
    const merged = mergePartsById(
      [text('p1', 'hello world')],
      [text('p1', 'hello')],
      { monotonicText: true },
    );
    expect(merged).toEqual([text('p1', 'hello world')]);
  });

  it('开启后：前缀扩展（append-only 累积）→ 接受新快照', () => {
    const merged = mergePartsById(
      [text('p1', 'hello')],
      [text('p1', 'hello world')],
      { monotonicText: true },
    );
    expect(merged).toEqual([text('p1', 'hello world')]);
  });

  it('开启后：新快照是更完整全文、旧为后缀片段（重连后截断）→ 接受新快照修正', () => {
    const merged = mergePartsById(
      [text('p1', 'world')],
      [text('p1', 'hello world')],
      { monotonicText: true },
    );
    expect(merged).toEqual([text('p1', 'hello world')]);
  });

  it('开启后：更长但与前缀/后缀皆无包含关系（无关改写）→ 丢弃', () => {
    const merged = mergePartsById(
      [text('p1', 'hello world')],
      [text('p1', 'world and beyond')],
      { monotonicText: true },
    );
    expect(merged).toEqual([text('p1', 'hello world')]);
  });

  it('开启后：类型不同→仅新快照更长时接受（容许修正类型），更短保留旧类型', () => {
    const reasoning = { id: 'p1', type: 'reasoning', text: 'hello world' };
    // 合成 text 快照更短 → 保留 reasoning（防思考内容被错标成正文）
    expect(
      mergePartsById([reasoning], [text('p1', 'hi')], { monotonicText: true }),
    ).toEqual([reasoning]);
    // 合成 text 快照更长 → 接受（顺带修正成 text，随后由权威快照/终态收敛）
    expect(
      mergePartsById([reasoning], [text('p1', 'hello world more')], {
        monotonicText: true,
      }),
    ).toEqual([text('p1', 'hello world more')]);
  });

  it('开启后：tool part 状态流转不受影响（last-write-wins 照旧）', () => {
    const running = {
      id: 'tool1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' } },
    };
    const done = {
      id: 'tool1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt' },
    };
    expect(mergePartsById([running], [done], { monotonicText: true })).toEqual([done]);
  });

  it('开启后：reasoning 的 summary/thoughts 候选字段同样计入单调比较', () => {
    const older = { id: 'r1', type: 'reasoning', summary: '想'.repeat(80) };
    const shorter = { id: 'r1', type: 'reasoning', summary: '想'.repeat(10) };
    expect(mergePartsById([older], [shorter], { monotonicText: true })).toEqual([
      older,
    ]);
  });

  it('开启后：新 id 仍按到达顺序追加', () => {
    const merged = mergePartsById([text('p1', 'a')], [text('p2', 'b')], {
      monotonicText: true,
    });
    expect(merged).toEqual([text('p1', 'a'), text('p2', 'b')]);
  });
});
