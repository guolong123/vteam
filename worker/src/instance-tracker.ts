/**
 * F2 M4：活动实例（会话）计数——心跳 load.instances 的唯一事实源。
 *
 * 语义（metric 变更）：load.instances = **去重后的活跃会话数**（distinct sessions），
 * 而非「start 次数 - end 次数」的裸计数。同一会话并发/重入（多次 start）只算 1；
 * 每个会话用 refcount 记录未结束的执行次数，归零才从 Map 移除。
 * 会话键（sessionKey）由调用方给出：worker 侧正式键为 opencode 会话 id（ses_ 前缀），
 * 执行开始前先以请求 sessionId（或临时 anon 键）入账，createSession 成功后经
 * trackInstanceRekey 迁移到真实 opencode id——故同一逻辑执行不会因换键被重复计数。
 *
 * 泄漏护栏（getLoad）：Map 无法像裸计数那样「钳制到 maxInstances」，故异常膨胀/
 * 长期挂死时直接 clear 重置（宁可从 0 重新观察，也不虚报脏计数给 server 容量调度）。
 */

/** 会话键 → 未结束执行 refcount（>0）。归零即从 Map 删除（size = 去重会话数）。 */
const activeSessions = new Map<string, number>();
let idleHandler: (() => void) | null = null;
/** 最近一次 start 时间戳（30 分钟陈旧护栏基准）。 */
let lastStartAt = 0;

/**
 * 会话开始执行：对应 sessionKey 的 refcount +1，刷新 lastStartAt。
 * 返回 **去重活跃会话数**（Map.size）——调用方可用作快速判定。
 */
export function trackInstanceStart(sessionKey: string): number {
  activeSessions.set(sessionKey, (activeSessions.get(sessionKey) ?? 0) + 1);
  lastStartAt = Date.now();
  return activeSessions.size;
}

/** 注册「活跃会话归零」回调（T4c 挂起的重启检查点；null = 注销）。 */
export function onActiveSessionsIdle(handler: (() => void) | null): void {
  idleHandler = handler;
}

/**
 * 会话结束执行：对应 sessionKey 的 refcount -1；≤0 时删除该键（会话完全结束）。
 * 归零（Map 为空）时触发 idle 回调——**保持 T4c 原语义**：会话全部结束时是挂起
 * 重启/自更新的唯一续跑执行点。返回去重活跃会话数。
 */
export function trackInstanceEnd(sessionKey: string): number {
  const count = activeSessions.get(sessionKey);
  if (count !== undefined) {
    if (count - 1 <= 0) {
      activeSessions.delete(sessionKey);
    } else {
      activeSessions.set(sessionKey, count - 1);
    }
  }
  if (activeSessions.size === 0 && idleHandler) {
    idleHandler();
  }
  return activeSessions.size;
}

/**
 * 会话键迁移：把一个 refcount 从 oldKey 移到 newKey（保留既有未结束计数）。
 * 典型场景：执行开始时以请求 sessionId/临时 anon 键入账，createSession 成功拿到真实
 * opencode 会话 id 后重键——否则 start/end 用了不同的键，计数永不归零（泄漏）。
 * oldKey 无条目或新旧键相同 → 空操作（幂等，防御调用点重复 rekey）。
 */
export function trackInstanceRekey(oldKey: string, newKey: string): void {
  if (oldKey === newKey) {
    return;
  }
  const count = activeSessions.get(oldKey);
  if (count === undefined) {
    return;
  }
  activeSessions.delete(oldKey);
  activeSessions.set(newKey, (activeSessions.get(newKey) ?? 0) + count);
}

/**
 * 心跳 load 快照：{ instances: 去重活跃会话数 }。
 *
 * 泄漏护栏（沿用 F2 M4 的两条阈值，但动作改为 clear——Map 无法"钳制"到上限）：
 * - 异常膨胀：instances > maxInstances * 4（远超容量，几乎必是计数泄漏）→ 清空重置；
 * - 长期陈旧：有活跃会话但 lastStartAt 距今 > 30 分钟未刷新（挂死/未配对 end）→ 清空重置。
 * 返回形状保持 `{ instances }` 不变（协议契约，绝不新增字段）。
 */
export function getLoad(maxInstances?: number): { instances: number } {
  if (maxInstances && maxInstances > 0 && activeSessions.size > maxInstances * 4) {
    activeSessions.clear();
  }
  if (lastStartAt && activeSessions.size > 0 && Date.now() - lastStartAt > 30 * 60 * 1000) {
    activeSessions.clear();
  }
  return { instances: activeSessions.size };
}

/** 重置计数（单测隔离 / 需要从 0 重新观察时）。 */
export function resetInstanceCount(): void {
  activeSessions.clear();
  lastStartAt = 0;
}
