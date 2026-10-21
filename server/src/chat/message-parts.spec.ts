import { Logger } from '@nestjs/common';
import {
  INJECTED_PROMPT_MARKERS,
  isInjectedPromptPart,
  mergePartsById,
  normalizeParts,
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
    const merged = mergePartsById(
      [text('p1', 'hello world')],
      [text('p1', 'hi')],
    );
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
    expect(mergePartsById([running], [done], { monotonicText: true })).toEqual([
      done,
    ]);
  });

  it('开启后：reasoning 的 summary/thoughts 候选字段同样计入单调比较', () => {
    const older = { id: 'r1', type: 'reasoning', summary: '想'.repeat(80) };
    const shorter = { id: 'r1', type: 'reasoning', summary: '想'.repeat(10) };
    expect(mergePartsById([older], [shorter], { monotonicText: true })).toEqual(
      [older],
    );
  });

  it('开启后：新 id 仍按到达顺序追加', () => {
    const merged = mergePartsById([text('p1', 'a')], [text('p2', 'b')], {
      monotonicText: true,
    });
    expect(merged).toEqual([text('p1', 'a'), text('p2', 'b')]);
  });
});

/**
 * 存储形态边界（opencode v2 适配 T20）。
 *
 * 夹具取自**实机证据**：
 * - v1 形 part：`.omo/evidence/dm-session-dump/raw-session.json`（opencode v1 真实
 *   会话 dump；字段集 = `id/sessionID/messageID/type/text|tool|state|reason/cost/tokens`）。
 * - v2 形 content 项：`docs/agent-platform/opencode-v2-contract-baseline/openapi.json`
 *   的 `Session.Message.Assistant.Text/.Reasoning/.Tool`（v2 的 `content[]` 取代
 *   v1 的 `parts[]`；工具名键是 `name`、输出在 `state.content[]`）。
 */
describe('存储形态边界 normalizeParts（v1 形 parts[] / v2 形 content[] → 同一内部模型）', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** web（msg-parts.tsx）实际读取的字段视图——形状等价断言只比这一层。 */
  const webView = (part: Record<string, unknown>) => {
    const state =
      part.state !== null && typeof part.state === 'object'
        ? (part.state as Record<string, unknown>)
        : undefined;
    return {
      id: part.id,
      type: part.type,
      text: part.text,
      // web 读的是 `p.synthetic === true`（字段缺失 ≡ false）
      synthetic: part.synthetic === true,
      tool: part.tool,
      status: state?.status,
    };
  };

  it('v1 形 content（{parts:[...]}）→ 原样透传（字段一个都不改）', () => {
    const part = {
      id: 'prt_1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'text',
      text: '你好',
    };
    expect(normalizeParts({ parts: [part] })).toEqual([part]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('裸 part 数组 → 透传（内部调用点的既有口径不变）', () => {
    const part = { id: 'prt_1', type: 'text', text: '你好' };
    expect(normalizeParts([part, null, 'x'])).toEqual([part]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('v2 形 content（{content:[...]}）→ 归一成内部模型（name→tool、state.content[]→state.output）', () => {
    const parts = normalizeParts({
      id: 'msg_1',
      sessionID: 'ses_1',
      content: [
        { type: 'text', text: '结论如下' },
        { type: 'reasoning', text: '思考中' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'vteam_chat_history',
          state: {
            status: 'completed',
            input: { teamId: 'tm_1' },
            content: [{ type: 'text', text: '[]' }],
          },
        },
      ],
    });

    expect(parts).toHaveLength(3);
    // 文本：type/text 保留，id 按「消息id:序号」规则派生（与 v2 驱动同规则）
    expect(parts[0]).toEqual({
      id: 'msg_1:0',
      messageID: 'msg_1',
      sessionID: 'ses_1',
      type: 'text',
      text: '结论如下',
    });
    expect(parts[1].type).toBe('reasoning');
    // 工具：v2 的 name → 内部模型的 tool；provider call id 落 callID
    expect(parts[2].tool).toBe('vteam_chat_history');
    expect(parts[2].callID).toBe('call_1');
    // 工具输出：v2 的 state.content[]（数组）→ 内部模型的 state.output（字符串）
    const state = parts[2].state as Record<string, unknown>;
    expect(state.output).toBe('[]');
    expect(state.status).toBe('completed');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('v2 工具错误：state.error 对象 → 内部模型的 state.error 字符串（原对象留 errorDetail）', () => {
    const parts = normalizeParts({
      id: 'msg_1',
      content: [
        {
          type: 'tool',
          id: 'call_1',
          name: 'bash',
          state: {
            status: 'error',
            input: {},
            error: { type: 'validation', message: '参数非法' },
          },
        },
      ],
    });
    const state = parts[0].state as Record<string, unknown>;
    expect(state.error).toBe('参数非法');
    expect(state.errorDetail).toEqual({
      type: 'validation',
      message: '参数非法',
    });
  });

  it('v2 工具状态大写形态 → 小写（与 v1 的 running/streaming/completed/error 同族）', () => {
    const parts = normalizeParts({
      id: 'msg_1',
      content: [
        { type: 'tool', name: 'bash', state: { status: 'Running', input: {} } },
      ],
    });
    expect((parts[0].state as Record<string, unknown>).status).toBe('running');
  });

  it('垃圾输入 → 不抛错、降级为空 part 集并记一条 WARN', () => {
    expect(() => normalizeParts('garbage')).not.toThrow();
    expect(normalizeParts('garbage')).toEqual([]);
    expect(normalizeParts(42)).toEqual([]);
    expect(normalizeParts({ nope: 1 })).toEqual([]);
    expect(normalizeParts({ parts: 'not-an-array' })).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('null/undefined → 空集且不告警（正常缺省，不是异常形态）', () => {
    expect(normalizeParts(null)).toEqual([]);
    expect(normalizeParts(undefined)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('step-finish part 在归一后保留（控制面拿它做「本轮完成」幂等键，丢弃即失效）', () => {
    const finish = {
      id: 'prt_finish',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'step-finish',
      reason: 'tool-calls',
      cost: 0,
      tokens: { total: 19314, input: 15936, output: 306 },
    };
    expect(normalizeParts({ parts: [finish] })).toEqual([finish]);
  });

  it('形状等价（v1 形 part vs 等价 v2 形 content 项）：web 读到的字段完全一致', () => {
    // v1 形（opencode v1 真实 part；id 取 `消息id:序号` 以与 v2 派生规则对齐比较）
    const v1Part = {
      id: 'msg_1:0',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'vteam_chat_history',
      state: {
        status: 'completed',
        input: { teamId: 'tm_1', limit: 10 },
        output: '[]',
      },
    };
    // v2 形（同一逻辑 part 的 v2 wire 形态：工具名 name、输出在 state.content[]）
    const v2Message = {
      id: 'msg_1',
      sessionID: 'ses_1',
      content: [
        {
          type: 'tool',
          id: 'call_1',
          name: 'vteam_chat_history',
          state: {
            status: 'completed',
            input: { teamId: 'tm_1', limit: 10 },
            content: [{ type: 'text', text: '[]' }],
          },
        },
      ],
    };

    const fromV1 = normalizeParts({ parts: [v1Part] });
    const fromV2 = normalizeParts(v2Message);
    expect(fromV1).toHaveLength(1);
    expect(fromV2).toHaveLength(1);
    // 断言口径 = web 真正读的字段
    expect(webView(fromV2[0])).toEqual(webView(fromV1[0]));
    // 内部模型的关键字段名也一致（不只是 web 视图层）
    expect(fromV2[0].tool).toBe(fromV1[0].tool);
    expect((fromV2[0].state as Record<string, unknown>).output).toBe(
      (fromV1[0].state as Record<string, unknown>).output,
    );
  });

  it('形状等价（正文 part）：v1 形 text part 与 v2 形 text content 项归一后等价', () => {
    const v1Part = {
      id: 'msg_1:0',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'text',
      text: '结论如下',
    };
    const v2Message = {
      id: 'msg_1',
      sessionID: 'ses_1',
      content: [{ type: 'text', text: '结论如下' }],
    };
    expect(webView(normalizeParts(v2Message)[0])).toEqual(
      webView(normalizeParts({ parts: [v1Part] })[0]),
    );
  });
});
