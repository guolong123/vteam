/**
 * 驱动工厂（计划 T8 / 决策 D1；**T18 起单轨**：只有 v2）。
 *
 * 为什么要有工厂而不是各处 `new V2Driver(...)`：
 * - 业务层只应依赖**接缝**（`OpenCodeDriver`），但「用哪个实现」是**部署决策**，
 *   不该散落在业务代码里。
 * - 有了工厂，「加一版实现」= 加一个文件 + 在这里登记一行，业务层零改动。
 *
 * ⚠️ **T18：v1 驱动已删除**（计划 §9.3 的回滚保险用尽，此后彻底单轨）：
 * - v1 线（`opencode-ai`）已冻结在 1.19.3，永远到不了 v2；双驱动维护面翻倍却服务一条死线。
 * - `OPENCODE_V2_ENABLED=false` **不再**是「退回 v1」的代码级开关：它现在**响亮失败**
 *   （见 `V1_DRIVER_REMOVED_MESSAGE`），避免运维以为切了开关、实际跑的还是别的实现。
 * - 唯一有效的回退是**代码/镜像回滚**到 v1.0.x tag（并回滚 opencode 数据卷——v2 启动时
 *   已就地迁移该卷，v1 读不了）。
 *
 * ⚠️ **v2 模式不再有"静默回退"**（T9 交付 v2 驱动时引入）：
 * v2 模式在未注入 v2 构造入口时**快速失败**并给出可操作的错误（镜像与代码版本必须匹配）——
 * v1 的路径（`/session`、`/event`…）在 v2 上**不 404，而是 200 + web SPA 的 HTML**，
 * 驱动会把 HTML 当 JSON 解析，全程没有错误信号。
 */

import { Logger, OpenCodeDriver } from './opencode-driver';
import { V2Driver } from './v2-driver';
import { SystemHandoffPort } from './v2-system-handoff';

/**
 * 驱动模式。
 *
 * `'v1'` 保留在类型里**只为给出响亮的失败**（老配置/老调用点仍可能传它）——
 * T18 起**没有任何** v1 实现，命中即抛错。
 */
export type OpencodeDriverMode = 'v1' | 'v2';

/** 驱动实现（模式 → 实现的落点）。 */
export type OpencodeDriverImplementation = 'v2';

/** 驱动构造选项（各实现共用的最小面）。 */
export interface OpencodeDriverOptions {
  /** 被驱动端基址；启动前可留空（启动成功后注入） */
  baseUrl?: string;
  /** 被驱动端鉴权口令（空 = 不鉴权） */
  serverPassword?: string;
  /** 单次请求超时 ms */
  timeoutMs?: number;
  /** 日志输出 */
  logger?: Logger;
  /** 默认工作目录（v2 建会话时的 location.directory；缺省 = 被驱动端默认目录） */
  directory?: string;
  /**
   * 逐消息 system blob 的**插件交接**通道（D6 候选 (f)；v2 专有）。
   *
   * 缺省 = 不启用 ⇒ 顶层 system 走**文本前缀兜底**（永远可用的下限）。
   */
  systemHandoff?: SystemHandoffPort;
}

/** 工厂入参（构造选项 + 模式 + v2 实现注入点）。 */
export interface CreateOpencodeDriverOptions extends OpencodeDriverOptions {
  /** 驱动模式；缺省 v2（`'v1'` → 抛错：v1 驱动已删除） */
  mode?: OpencodeDriverMode;
  /**
   * v2 实现的构造入口（**默认即 v2 真实实现**；注入点用于单测/特殊部署）。
   * 返回空 → v2 模式**快速失败**（不再静默回退 v1）。
   */
  createV2Driver?: (options: OpencodeDriverOptions) => OpenCodeDriver | undefined;
}

/**
 * v1 模式命中时的**可操作**错误文案（T18 单轨收口）。
 *
 * 为什么必须响亮：留着「看起来能切、实际切不了」的开关 = 运维在故障时按错的方向排查
 * （切了开关发现行为没变 → 误判为别的问题）。宁可启动即失败并指向真正的回退手段。
 */
export const V1_DRIVER_REMOVED_MESSAGE =
  '[driver] v1 驱动已随 v2 切换移除（T18 单轨收口）：OPENCODE_V2_ENABLED=false 不再受支持；' +
  '回退请回滚镜像/代码到 v1.0.x（并一并回滚 opencode 数据卷——v2 启动时已就地迁移该卷，v1 读不了）。';

/**
 * 开关 → 模式（纯函数）。
 *
 * ⚠️ `false`（即 `OPENCODE_V2_ENABLED=false`）**抛错**而不是回落成 v1：
 * v1 实现已删除，"回落"没有第二个实现可选，静默继续跑只会让故障现场更难解释。
 */
export function resolveOpencodeDriverMode(v2Enabled: boolean): OpencodeDriverMode {
  if (!v2Enabled) {
    throw new Error(V1_DRIVER_REMOVED_MESSAGE);
  }
  return 'v2';
}

/**
 * 模式 → 实现（**选择决策**，纯函数）。
 *
 * 单独抽出是为了可单测：实现的「落地」与「选择」是两件事——选择决策必须先于实现存在，
 * 否则「加一版」就得先改业务代码。
 *
 * ⚠️ `'v1'` → **抛错**（T18：v1 实现已删除；命中即响亮失败，绝不静默换实现）。
 */
export function selectOpencodeDriverImplementation(
  mode: OpencodeDriverMode,
): OpencodeDriverImplementation {
  if (mode === 'v1') {
    throw new Error(V1_DRIVER_REMOVED_MESSAGE);
  }
  return 'v2';
}

/** v2 模式的默认构造入口 = v2 真实实现。 */
function defaultCreateV2Driver(options: OpencodeDriverOptions): OpenCodeDriver {
  return new V2Driver(options);
}

/**
 * 按模式构造驱动实现。
 *
 * @param options.mode 驱动模式；缺省 v2（`'v1'` → 抛错：v1 驱动已删除）
 * @param options.createV2Driver v2 实现构造入口（缺省 = `V2Driver`；返回空 → 快速失败）
 * @throws 模式为 v1（v1 驱动已删除）或 v2 模式拿不到 v2 驱动时抛错
 *   （**绝不**回退 v1——v1 的路径在 v2 上返回 200 + HTML）
 */
export function createOpencodeDriver(
  options: CreateOpencodeDriverOptions = {},
): OpenCodeDriver {
  const mode = options.mode ?? 'v2';
  // 选择决策先落地（v1 → 抛错）。
  selectOpencodeDriverImplementation(mode);
  const create = options.createV2Driver ?? defaultCreateV2Driver;
  const v2 = create(options);
  if (v2) {
    return v2;
  }
  throw new Error(
    '[driver] v2 模式但 v2 驱动不可用（createV2Driver 未产出驱动）：' +
      '请确认 worker 镜像与代码版本匹配（v2 模式需要 opencode v2 的 /api 契约；' +
      'v1 的 legacy 路径对着 v2 服务会把 web SPA 的 HTML 当 JSON 解析，且不会报错）',
  );
}
