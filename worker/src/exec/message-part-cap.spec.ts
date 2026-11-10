/**
 * worker 出口 part 截断纯函数单测（perf：session-history 80MB 无效传输）。
 *
 * 契约要求与 server `ChatService.capPartPayloads` 同口径：
 * - 字符串 ≤ maxChars（超出追加截断标记）、数组 ≤20 项、对象递归深度 ≤4；
 * - part 结构/身份键（id/messageID/sessionID/callID/type/tool/time）原样保留；
 * - `type='text'` 的 part 自身 `text` 不截断（否则服务端 content.text 会变）；
 * - 纯函数：不 mutate 入参。
 */
import {
  capMessagePart,
  capMessageParts,
  MESSAGE_PART_CAP_DEFAULT_ARRAY_ITEMS,
  MESSAGE_PART_CAP_DEFAULT_DEPTH,
  MESSAGE_PART_TRUNCATED_SUFFIX,
} from './message-part-cap';

/** 构造一个超长字符串。 */
function bigString(length = 10_000): string {
  return 'x'.repeat(length);
}

describe('capMessagePart（与 server capPartPayloads 同口径）', () => {
  it('text part：自身 text 不截断，其余字符串字段截断到 maxChars', () => {
    const part = {
      id: 'prt_text',
      messageID: 'msg_1',
      sessionID: 'ses_1',
      type: 'text',
      text: bigString(10_000),
      // 非正文的其它字符串字段仍应截断（与服务端对 parts 的兜底口径一致）
      detail: bigString(10_000),
      time: { created: 1, completed: 2 },
    };

    const capped = capMessagePart(part, { maxChars: 2048 }) as Record<
      string,
      unknown
    >;

    expect(capped.text).toBe(part.text); // 正文逐字保留
    expect(capped.detail).toBe(
      bigString(2048) + MESSAGE_PART_TRUNCATED_SUFFIX,
    );
    // 结构/身份键原样保留
    expect(capped.id).toBe('prt_text');
    expect(capped.messageID).toBe('msg_1');
    expect(capped.sessionID).toBe('ses_1');
    expect(capped.type).toBe('text');
    expect(capped.time).toEqual({ created: 1, completed: 2 });
  });

  it('tool part：state 内容（嵌套字符串/数组）递归截断，结构键保留', () => {
    const part = {
      id: 'prt_tool',
      callID: 'call_1',
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: bigString(10_000) },
        output: bigString(10_000),
        content: [
          { type: 'text', text: bigString(10_000) },
          { type: 'text', text: bigString(10_000) },
        ],
      },
      time: { start: 1, end: 2 },
    };

    const capped = capMessagePart(part, { maxChars: 2048 }) as any;

    expect(capped.callID).toBe('call_1');
    expect(capped.tool).toBe('bash');
    expect(capped.time).toEqual({ start: 1, end: 2 });
    // state 结构保留、内容截断
    expect(capped.state.status).toBe('completed');
    expect(capped.state.output).toBe(
      bigString(2048) + MESSAGE_PART_TRUNCATED_SUFFIX,
    );
    expect(capped.state.input.command).toBe(
      bigString(2048) + MESSAGE_PART_TRUNCATED_SUFFIX,
    );
    expect(capped.state.content[0].text).toBe(
      bigString(2048) + MESSAGE_PART_TRUNCATED_SUFFIX,
    );
    // 截断后 JSON 体积显著小于原始（5 处 10KB 字符串 → 5 处 ~2KB）
    const before = JSON.stringify(part).length;
    const after = JSON.stringify(capped).length;
    expect(after).toBeLessThan(before / 3);
  });

  it('数组超过 20 项截断并追加标记；小数组原样', () => {
    const bigArray = Array.from(
      { length: MESSAGE_PART_CAP_DEFAULT_ARRAY_ITEMS + 5 },
      (_, index) => `item-${index}`,
    );
    const part = { type: 'tool', state: { content: bigArray } };
    const capped = capMessagePart(part, { maxChars: 2048 }) as any;

    expect(capped.state.content).toHaveLength(
      MESSAGE_PART_CAP_DEFAULT_ARRAY_ITEMS + 1, // 20 项 + 截断标记
    );
    expect(capped.state.content[19]).toBe('item-19');
    expect(capped.state.content[20]).toBe(
      `…（共 ${bigArray.length} 项，仅展示前 ${MESSAGE_PART_CAP_DEFAULT_ARRAY_ITEMS} 项）`,
    );

    const small = [1, 2, 3];
    const smallPart = capMessagePart(
      { type: 'tool', state: { content: small } },
      { maxChars: 2048 },
    ) as any;
    expect(smallPart.state.content).toEqual([1, 2, 3]);
  });

  it('递归深度上限：达到 maxDepth 的对象原样返回（与 server capValue 对齐）', () => {
    // part(depth0) → field 对象(depth1) → … → 第 4 层对象不再递归
    const deepValue = { leaf: bigString(10_000) };
    const part = {
      type: 'tool',
      state: {
        l1: {
          l2: {
            l3: deepValue,
          },
        },
      },
    };

    const capped = capMessagePart(part, { maxChars: 2048 }) as any;
    // state(depth1) → l1(2) → l2(3) → l3(4)：depth 4 处对象原样返回（不截断其 leaf）
    expect(capped.state.l1.l2.l3.leaf).toBe(bigString(10_000));
    expect(MESSAGE_PART_CAP_DEFAULT_DEPTH).toBe(4);
  });

  it('不 mutate 入参（返回全新对象/数组）', () => {
    const part = {
      type: 'tool',
      state: { output: bigString(10_000) },
    };
    const snapshot = JSON.stringify(part);

    const capped = capMessagePart(part, { maxChars: 64 }) as any;

    expect(JSON.stringify(part)).toBe(snapshot); // 原对象未变
    expect(capped).not.toBe(part);
    expect(capped.state).not.toBe(part.state);
  });

  it('maxChars 非法（0/负数/非整数）→ 原样返回（不截断）', () => {
    const part = { type: 'text', text: bigString(100) };
    for (const maxChars of [0, -1, 1.5, Number.NaN]) {
      expect(capMessagePart(part, { maxChars })).toEqual(part);
    }
  });

  it('非对象 part（异常数据）按值规则处理，不抛错', () => {
    expect(capMessagePart('x'.repeat(100), { maxChars: 10 })).toBe(
      'x'.repeat(10) + MESSAGE_PART_TRUNCATED_SUFFIX,
    );
    expect(capMessagePart(null, { maxChars: 10 })).toBeNull();
    expect(capMessagePart(42, { maxChars: 10 })).toBe(42);
  });
});

describe('capMessageParts（批量消息）', () => {
  it('只截断 parts，info 原样保留、消息顺序不变', () => {
    const messages = [
      {
        info: { id: 'msg_1', role: 'user', time: { created: 1 } },
        parts: [{ id: 'prt_1', type: 'text', text: bigString(10_000) }],
      },
      {
        info: { id: 'msg_2', role: 'assistant' },
        parts: [
          {
            id: 'prt_2',
            type: 'tool',
            tool: 'bash',
            state: { output: bigString(10_000) },
          },
        ],
      },
    ];

    const capped = capMessageParts(messages, { maxChars: 2048 }) as any[];

    expect(capped.map((m) => m.info.id)).toEqual(['msg_1', 'msg_2']);
    expect(capped[0].info).toEqual(messages[0].info);
    // text part 正文保留
    expect(capped[0].parts[0].text).toBe(bigString(10_000));
    // tool state 截断
    expect(capped[1].parts[0].state.output).toBe(
      bigString(2048) + MESSAGE_PART_TRUNCATED_SUFFIX,
    );
    // 入参未变
    expect((messages[1].parts[0] as any).state.output).toBe(bigString(10_000));
  });
});
