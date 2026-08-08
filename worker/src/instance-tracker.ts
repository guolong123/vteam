/**
 * F2 M4：活动实例计数（简单计数器）。
 *
 * M4 阶段 worker 侧会话执行链路尚未接线（C1/并行任务），先用进程内计数器让心跳上报
 * 真实 load，server 容量调度（Scheduler.assignWorker 的 capacity = maxInstances - instances）
 * 才能感知负载。T10 会话执行接入后由调用点挂钩：
 *   - 创建会话成功（V1Driver.createSession 返回 sessionID）→ trackInstanceStart()
 *   - abort / 会话完成（task.completed / step-finish）→ trackInstanceEnd()
 * 本阶段不区分实例粒度，计数即可；跨进程/持久化留待 Phase 5。
 */

let activeInstances = 0;

/** 会话创建 +1；返回当前活动实例数。 */
export function trackInstanceStart(): number {
  activeInstances += 1;
  return activeInstances;
}

/** 会话结束（abort/完成） -1；下限钳制 0，返回当前活动实例数。 */
export function trackInstanceEnd(): number {
  activeInstances = Math.max(0, activeInstances - 1);
  return activeInstances;
}

/** 心跳负载快照（WorkerLoad.instances = 当前活动会话数）。 */
export function getLoad(): { instances: number } {
  return { instances: activeInstances };
}

/** 测试辅助：重置计数（仅 spec 隔离用）。 */
export function resetInstanceCount(): void {
  activeInstances = 0;
}
