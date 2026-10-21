/**
 * v2 part id 口径（`v2-part-id.ts`）单元测试。
 *
 * 覆盖：
 * - 各类内容的 id 形状（文本/思考/工具/step-finish）；
 * - **统一形态的识别**（旧的下标形态必须被识别为「非统一」，否则边界会二次改写）；
 * - 派生器的**同类序号**语义（第 k 段同类内容加 `:k`，且不依赖其它类别）。
 */

import {
  V2PartIdDeriver,
  isUnifiedV2PartId,
  parseUnifiedV2PartId,
  v2ContentPartId,
  v2ReasoningPartId,
  v2StepFinishPartId,
  v2TextPartId,
  v2ToolPartId,
} from './v2-part-id';

describe('v2 part id 的形状', () => {
  it('文本 / 思考 / 工具 / step-finish 各自的 id', () => {
    expect(v2TextPartId('msg_1')).toBe('msg_1:text');
    expect(v2ReasoningPartId('msg_1')).toBe('msg_1:reasoning');
    expect(v2ToolPartId('msg_1', 'call_1')).toBe('msg_1:tool:call_1');
    expect(v2StepFinishPartId('msg_1')).toBe('msg_1:step-finish');
  });

  it('同类第 k 段加序号；工具用 callID 区分', () => {
    expect(v2ContentPartId('msg_1', 'text', 0)).toBe('msg_1:text');
    expect(v2ContentPartId('msg_1', 'text', 1)).toBe('msg_1:text:1');
    expect(v2ContentPartId('msg_1', 'reasoning', 2)).toBe('msg_1:reasoning:2');
    expect(v2ContentPartId('msg_1', 'tool', 0, 'call_1')).toBe('msg_1:tool:call_1');
    // 工具缺 callID（纯防御）→ 退化为同类序号
    expect(v2ContentPartId('msg_1', 'tool', 0)).toBe('msg_1:tool:0');
  });
});

describe('统一形态的识别与解析', () => {
  it('统一形态 → 可解析（消息 id / 类别 / 序号 / callID）', () => {
    expect(parseUnifiedV2PartId('msg_1:text')).toEqual({
      messageID: 'msg_1',
      kind: 'text',
      occurrence: 0,
    });
    expect(parseUnifiedV2PartId('msg_1:text:2')).toEqual({
      messageID: 'msg_1',
      kind: 'text',
      occurrence: 2,
    });
    expect(parseUnifiedV2PartId('msg_1:reasoning:1')).toEqual({
      messageID: 'msg_1',
      kind: 'reasoning',
      occurrence: 1,
    });
    expect(parseUnifiedV2PartId('msg_1:tool:call_1')).toEqual({
      messageID: 'msg_1',
      kind: 'tool',
      occurrence: 0,
      callID: 'call_1',
    });
    expect(parseUnifiedV2PartId('msg_1:step-finish')).toEqual({
      messageID: 'msg_1',
      kind: 'step-finish',
      occurrence: 0,
    });
  });

  it('旧的下标形态与 v1 原生 id → **不是**统一形态（否则会被二次改写）', () => {
    expect(parseUnifiedV2PartId('msg_1:0')).toBeUndefined();
    expect(parseUnifiedV2PartId('prt_abc')).toBeUndefined();
    expect(isUnifiedV2PartId('msg_1:0')).toBe(false);
    expect(isUnifiedV2PartId('prt_abc')).toBe(false);
    expect(isUnifiedV2PartId('msg_1:text')).toBe(true);
    expect(isUnifiedV2PartId('msg_1:text:1')).toBe(true);
    expect(isUnifiedV2PartId('msg_1:tool:call_1')).toBe(true);
    expect(isUnifiedV2PartId('msg_1:step-finish')).toBe(true);
  });
});

describe('派生器（同类序号）', () => {
  it('序号只按同类别计（其它类别的存在与否不影响本类序号）', () => {
    const deriver = new V2PartIdDeriver('msg_1');
    expect(deriver.next('text')).toBe('msg_1:text');
    expect(deriver.next('tool', 'call_1')).toBe('msg_1:tool:call_1');
    expect(deriver.next('reasoning')).toBe('msg_1:reasoning');
    expect(deriver.next('text')).toBe('msg_1:text:1');
  });

  it('同类内容顺序不变时 id 恒定（重复派生同一序列 → 同一批 id）', () => {
    const derive = (): string[] => {
      const deriver = new V2PartIdDeriver('msg_1');
      return [deriver.next('text'), deriver.next('tool', 'call_1'), deriver.next('text')];
    };
    expect(derive()).toEqual(derive());
  });
});
