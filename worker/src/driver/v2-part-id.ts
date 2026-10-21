/**
 * v2 内容 part id 的**唯一**派生口径（单源；驱动与事件路共用）。
 *
 * ## 为什么必须单源
 *
 * part id 是 **server 侧合并 parts 的键**（`server/src/chat/message-parts.ts` 的
 * `mergePartsById` 按 `part.id` 做 last-write-wins）。同一个内容若在**两条产出路径**
 * 拿到**不同的 id**，server 侧就会把同一段正文存成**两个 part**（正文重复、工具卡重复）。
 *
 * 两条路径：
 * - **事件路**：SSE 帧 → 映射表（`v2-event-map.ts`）——只知道「哪条消息的哪类内容」；
 * - **轮询路**：驱动拉消息快照（`v2-driver.ts`）——知道 `content[]` 的每一项。
 *
 * 改造前：驱动合成 `${messageID}:${index}`（计划 D5 的旧口径），事件路合成
 * `${messageID}:text` / `${messageID}:tool:${callID}`（更丰富的口径），两套形态**在
 * 上送边界**（exec-server）被 reconcile——于是**worker 内部**同时存在两种 id 形态
 * （任何直接消费驱动消息的代码看到的都是下标形态），一旦有人按 `part.id` 记账
 * （「这个 part 算过了吗？」），两条路就会各记一次 → server 侧出现重复 part。
 *
 * 改造后：**id 由驱动产出**（唯一实现），事件路与轮询路都从本文件取 → 形态一致。
 *
 * ## 口径
 *
 * 对 v2 的 assistant 消息 `content[]`（消息 id = `M`）：
 * - 文本 → `${M}:text`；同一条消息的**第 k 段**文本（k ≥ 1）→ `${M}:text:${k}`
 * - 思考 → `${M}:reasoning`；第 k 段 → `${M}:reasoning:${k}`
 * - 工具 → `${M}:tool:${callID}`（callID = provider 侧调用 id，两条路径都有）
 * - 合成的 step-finish → `${M}:step-finish`（**原样不动**——控制面的
 *   `findStepFinishPartKey` 按 part id 做「本轮完成」幂等键，改了会打断既有键）
 *
 * ## 稳定性（同一内容每次轮询必须得到同一个 id）
 *
 * - **序号只按「同类别」计**（第 k 段文本就是第 k 段文本），**不依赖其它类别是否存在**
 *   → 一条消息里先出现 tool 还是先出现 reasoning，都不会让文本的 id 漂移；
 * - v2 的 `content[]` 是**追加式**增长（只增不改）→ 已有内容的 id 永不变；
 * - 事件路的文本/思考流天然只有一段（`${M}:text` / `${M}:reasoning`）→ 与轮询路的
 *   「第 0 段」对齐；多段文本的额外段（`:1`、`:2`…）只有轮询路产出（事件路无法区分
 *   同一消息里的多段文本——见 `v2-event-map.ts` 的映射表，**不改**）。
 */

/** v2 内容类别（决定 id 的中段）。 */
export type V2PartKind = 'text' | 'reasoning' | 'tool';

/** step-finish 的 id 段名（控制面幂等键依赖它，**勿改**）。 */
export const V2_STEP_FINISH_SEGMENT = 'step-finish';

/** 文本 part id（一条消息的第 0 段文本）。 */
export function v2TextPartId(messageID: string): string {
  return `${messageID}:text`;
}

/** 思考 part id（一条消息的第 0 段思考）。 */
export function v2ReasoningPartId(messageID: string): string {
  return `${messageID}:reasoning`;
}

/** 工具 part id（callID = provider 侧调用 id；两条路径都能拿到同一个值）。 */
export function v2ToolPartId(messageID: string, callID: string): string {
  return `${messageID}:tool:${callID}`;
}

/** step-finish part id（控制面「本轮完成」幂等键）。 */
export function v2StepFinishPartId(messageID: string): string {
  return `${messageID}:${V2_STEP_FINISH_SEGMENT}`;
}

/**
 * 内容 part id（**统一派生入口**）。
 *
 * @param messageID 所属消息 id
 * @param kind 内容类别（开放集合：兼容层还要处理驱动认识之外的类别）
 * @param occurrence 同一条消息内**同类别**内容的出现序号（0 基）
 * @param callID 工具的 provider 侧调用 id（仅 tool 用；缺失时退化为序号）
 */
export function v2ContentPartId(
  messageID: string,
  kind: V2PartKind | (string & {}),
  occurrence: number,
  callID?: string,
): string {
  if (kind === 'tool') {
    // 工具靠 callID 区分（provider 侧调用 id 天然唯一）；缺 callID 时退化为同类序号
    // （v2 实测工具项必有 id，故这是纯防御）。
    const segment =
      typeof callID === 'string' && callID !== '' ? callID : String(occurrence);
    return v2ToolPartId(messageID, segment);
  }
  // 第 0 段用无序号 id（与事件路一致）；同类第 k 段（k ≥ 1）加序号区分
  return occurrence === 0
    ? `${messageID}:${kind}`
    : `${messageID}:${kind}:${occurrence}`;
}

/** 统一形态 part id 的解析结果。 */
export interface V2UnifiedPartId {
  /** 所属消息 id。 */
  messageID: string;
  /** 内容类别（step-finish 单列——它不是「内容」，是合成的完成标记）。 */
  kind: V2PartKind | 'step-finish';
  /** 同类别序号（text/reasoning 有效；工具恒为 0——工具靠 callID 区分）。 */
  occurrence: number;
  /** 工具的 provider 侧调用 id。 */
  callID?: string;
}

/**
 * 解析**统一形态**的 part id。
 *
 * 统一形态 = `${M}:text` / `${M}:text:${k}` / `${M}:reasoning[.:${k}]` /
 * `${M}:tool:${callID}` / `${M}:step-finish`。
 *
 * ⚠️ 旧的下标形态（`${M}:${index}`）**不是**统一形态 → 返回 undefined。
 * 这个区分是**必须**的：`${M}:text:1` 若被当成下标形态再改写一次，会变成
 * `${M}:text:text` 这种垃圾 id（server 侧就再也合并不上了）。
 */
export function parseUnifiedV2PartId(id: string): V2UnifiedPartId | undefined {
  const matched = /^(.*):(text|reasoning|tool|step-finish)(?::(.*))?$/.exec(id);
  if (!matched) {
    return undefined;
  }
  const messageID = matched[1];
  const kind = matched[2] as V2PartKind | 'step-finish';
  const rest = matched[3];
  if (kind === 'tool') {
    return {
      messageID,
      kind,
      occurrence: 0,
      ...(rest !== undefined && rest !== '' ? { callID: rest } : {}),
    };
  }
  const occurrence = rest !== undefined && /^\d+$/.test(rest) ? Number(rest) : 0;
  return { messageID, kind, occurrence };
}

/** 该 id 是否已是**统一形态**（边界兼容层据此原样透传 ⇒ 幂等）。 */
export function isUnifiedV2PartId(id: string): boolean {
  return parseUnifiedV2PartId(id) !== undefined;
}

/**
 * 同一条消息内的内容 id 派生器（按类别**分别**计序号）。
 *
 * 用法（驱动的 `content[]` 逐项映射）：
 * ```ts
 * const deriver = new V2PartIdDeriver(messageID);
 * deriver.next('text');            // → `${messageID}:text`
 * deriver.next('tool', callID);    // → `${messageID}:tool:${callID}`
 * deriver.next('text');            // → `${messageID}:text:1`（第 2 段文本）
 * ```
 *
 * 为什么单独一个类：序号状态必须**跟着消息走**（每条消息一份），且**只依赖内容顺序**，
 * 不依赖其它类别是否存在 → 重复轮询同一消息时 id 恒定。
 */
export class V2PartIdDeriver {
  /** 同类别计数（text / reasoning / tool 各一份）。 */
  private readonly counters = new Map<V2PartKind, number>();

  constructor(private readonly messageID: string) {}

  /**
   * 取下一个同类内容的 id（并把该类计数 +1）。
   *
   * @param kind 内容类别
   * @param callID 工具的 provider 侧调用 id（仅 tool 用）
   */
  next(kind: V2PartKind, callID?: string): string {
    const occurrence = this.counters.get(kind) ?? 0;
    this.counters.set(kind, occurrence + 1);
    return v2ContentPartId(this.messageID, kind, occurrence, callID);
  }
}
