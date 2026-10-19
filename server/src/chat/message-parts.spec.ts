import {
  INJECTED_PROMPT_MARKERS,
  isInjectedPromptPart,
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
