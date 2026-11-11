/**
 * 成员工作状态（头像状态点）判定的单一来源。
 *
 * 产品语义（2026-11-10 用户确认）：
 * - **黄点** = 正在执行（`session.busyState === "running"`，此刻还在产出）
 * - **绿点** = 有新消息输出、且已不在执行（跑完一轮、处于空闲）
 * - **无点** = 没有会话 / 从未工作过
 *
 * 数据源有两个，**都必须支持**：
 * 1. `seat.sessionStatus`（团队 DTO 的**席位维度**状态，服务端按 `session.team_member_id`
 *    取，不依赖 `memberId`）——这是主来源，老席位（成员库解耦前建的、memberId 为 null）
 *    只有它有值。
 * 2. `member.session.busyState`（成员库维度）——成员库已回填时的补充来源，
 *    用于跨群「忙碌于其他群」的提示。
 *
 * 为什么不能只看第 2 个：成员库解耦前的老席位没有 member 行，
 * `memberById.get(seat.memberId ?? "")` 恒 undefined ⇒ 状态点永远不显示
 * （用户实测现象：成员明明在干活、头像却没有状态）。
 */

/** 状态点的三种视觉态。 */
export type MemberPresenceTone = "running" | "done" | "idle";

export interface MemberPresence {
  tone: MemberPresenceTone;
  /** 是否正在执行（黄点）。 */
  running: boolean;
  /** 是否有新输出且已空闲（绿点）。 */
  done: boolean;
  /** hover 文案（说明当前状态）。 */
  label: string;
}

/** 团队 DTO 的席级会话状态（结构对齐 `TeamMemberDto.sessionStatus`）。 */
export interface SeatSessionStatus {
  busyState: string;
  /**
   * 会话生命周期态（created / running / idle / frozen）。
   *
   * 为什么「执行中」要同时认它：`busy_state` 只在**轮次台账路径**
   * （`session_turns.claimNext`）被写成 running，而**团队直聊（team-mode，无 task）
   * 不写轮次台账** ⇒ busy_state 恒 idle，头像状态点永远不亮。
   * 线上实测：tmm_0000000025 正在执行、`session.status='running'`，`busy_state='idle'`
   * ⇒ 用户反馈「成员正在工作中，头像没有进行中提示」。status 在两条路径都会置
   * running，僵尸态另有 watchdog（scanIdleSessions）兜底收敛，故作为并列信号。
   */
  status?: string | null;
  busySince?: string | null;
  lastTurnOutcome?: string | null;
  lastActivityAt?: string | null;
}

/** 成员库维度的会话状态（结构对齐 `MemberDto.session`）。 */
export interface MemberSessionLike {
  busyState?: string;
  lastTurnOutcome?: string | null;
  currentTeamId?: string | null;
  lastActivityAt?: string | null;
}

/**
 * 「有新输出」的有效时间窗（毫秒，默认 30 分钟）。
 *
 * 为什么需要时间窗：`lastTurnOutcome` 是**每轮结束就写、之后一直留着**的字段，
 * 不设窗口的话，任何历史上跑过一轮的成员会永久挂绿点——绿点就失去「刚有新东西」的
 * 语义，变成噪音。超过窗口仍无活动 → 视为空闲（无点）。
 */
export const DONE_FRESH_WINDOW_MS = 30 * 60 * 1000;

/** 取「最近活动时间」时间戳（毫秒）；两路来源都看，取较新者；无效返回 NaN。 */
function latestActivityMs(
  seatStatus: SeatSessionStatus | null | undefined,
  memberSession: MemberSessionLike | null | undefined,
): number {
  const candidates = [seatStatus?.lastActivityAt, memberSession?.lastActivityAt]
    .map((v) => (v ? new Date(v).getTime() : NaN))
    .filter((n) => Number.isFinite(n));
  return candidates.length > 0 ? Math.max(...candidates) : NaN;
}

/**
 * 解析某席位的工作状态。
 *
 * 优先级：执行中（黄）> 新输出（绿）> 空闲（无点）。
 *
 * @param seatStatus 席级会话状态（主来源，可为 null）
 * @param memberSession 成员库会话状态（补充来源，可为 null）
 * @param runningLabel 「正在执行」时的文案后缀（如「正在本群处理」/「正在其他群处理」）
 * @param nowMs 当前时间（测试可注入；默认 Date.now()）
 */
export function resolveMemberPresence(
  seatStatus: SeatSessionStatus | null | undefined,
  memberSession: MemberSessionLike | null | undefined,
  runningLabel = "正在执行",
  nowMs: number = Date.now(),
): MemberPresence {
  // 黄点：任一路来源是 running 即视为执行中（席级优先，但两路都要认，
  // 否则成员库回填后席级缺值时黄点会闪没）。
  //
  // 席级多看一个 `status`：团队直聊不写 busy_state（见 SeatSessionStatus.status
  // 注释），只认 busyState 会让直聊执行中的成员永远不亮黄点。
  const running =
    seatStatus?.busyState === "running" ||
    seatStatus?.status === "running" ||
    memberSession?.busyState === "running";

  if (running) {
    return { tone: "running", running: true, done: false, label: runningLabel };
  }

  // 绿点：不在执行、最近一轮有产出、且活动时间还在新鲜窗口内。
  const hasOutcome =
    !!seatStatus?.lastTurnOutcome || !!memberSession?.lastTurnOutcome;
  if (hasOutcome) {
    const activity = latestActivityMs(seatStatus, memberSession);
    // 活动时间缺失 → 保守按「新鲜」处理（老数据没有该列时不至于全部熄灯）
    if (!Number.isFinite(activity) || nowMs - activity <= DONE_FRESH_WINDOW_MS) {
      return {
        tone: "done",
        running: false,
        done: true,
        label: "有新消息输出",
      };
    }
  }

  return { tone: "idle", running: false, done: false, label: "空闲" };
}

/** 状态点配色（与 chat 页既有忙碌橙 #F59E0B / 完成绿 #10B981 同族）。 */
export const PRESENCE_COLOR: Record<MemberPresenceTone, string> = {
  running: "#F59E0B",
  done: "#10B981",
  idle: "transparent",
};
