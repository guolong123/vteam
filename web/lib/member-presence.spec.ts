import { test, expect } from "@playwright/test";
import {
  DONE_FRESH_WINDOW_MS,
  PRESENCE_COLOR,
  resolveMemberPresence,
} from "./member-presence";

/**
 * 成员工作状态判定单测（头像状态点）。
 *
 * 这里锁的是用户 2026-11-10 确认的产品语义：
 * - 黄点 = 正在执行
 * - 绿点 = 有新消息输出、且已不在执行
 * - 无点 = 空闲 / 没有会话
 *
 * 以及一个关键的**回归锁**：老席位（`memberId` 为 null、只在团队 DTO 的
 * `sessionStatus` 里有状态）必须能显示状态点——这正是「成员在干活却看不到状态」
 * 的根因，不能因为只看成员库 `member.session` 再次退化。
 */
const NOW = new Date("2026-11-10T10:00:00.000Z").getTime();
const fresh = new Date(NOW - 60_000).toISOString(); // 1 分钟前
const stale = new Date(NOW - DONE_FRESH_WINDOW_MS - 60_000).toISOString(); // 窗口外

test.describe("resolveMemberPresence", () => {
  test("席级 running → 黄点（老席位 memberId=null 也能判定）", () => {
    const p = resolveMemberPresence({ busyState: "running" }, null, "正在执行", NOW);
    expect(p).toMatchObject({ tone: "running", running: true, done: false });
    expect(p.label).toBe("正在执行");
  });

  test("成员库 running 但席级缺值 → 仍是黄点（两路来源都认）", () => {
    const p = resolveMemberPresence(undefined, { busyState: "running" }, "正在执行", NOW);
    expect(p.tone).toBe("running");
  });

  test("running 优先于「有新输出」：正常多轮对话中不会显示成绿点", () => {
    const p = resolveMemberPresence(
      { busyState: "running", lastTurnOutcome: "ok", lastActivityAt: fresh },
      null,
      "正在执行",
      NOW,
    );
    expect(p.tone).toBe("running");
  });

  test("空闲 + 最近一轮有产出 + 活动新鲜 → 绿点", () => {
    const p = resolveMemberPresence(
      { busyState: "idle", lastTurnOutcome: "ok", lastActivityAt: fresh },
      null,
      "正在执行",
      NOW,
    );
    expect(p).toMatchObject({ tone: "done", running: false, done: true });
    expect(p.label).toBe("有新消息输出");
  });

  test("空闲 + 有产出但已超出新鲜窗口 → 无点（不让历史会话永久挂绿）", () => {
    const p = resolveMemberPresence(
      { busyState: "idle", lastTurnOutcome: "ok", lastActivityAt: stale },
      null,
      "正在执行",
      NOW,
    );
    expect(p.tone).toBe("idle");
  });

  test("空闲 + 无产出 → 无点", () => {
    const p = resolveMemberPresence({ busyState: "idle" }, null, "正在执行", NOW);
    expect(p.tone).toBe("idle");
    expect(p.label).toBe("空闲");
  });

  test("无会话（两路都为 null）→ 无点，不抛错", () => {
    expect(resolveMemberPresence(null, null, "正在执行", NOW).tone).toBe("idle");
    expect(resolveMemberPresence(undefined, undefined, "正在执行", NOW).tone).toBe("idle");
  });

  test("失败轮次（error）也算「有新输出」——用户要看到成员跑完了", () => {
    const p = resolveMemberPresence(
      { busyState: "idle", lastTurnOutcome: "error", lastActivityAt: fresh },
      null,
      "正在执行",
      NOW,
    );
    expect(p.tone).toBe("done");
  });

  test("缺活动时间（老数据无该列）→ 保守显示绿点，不至于全部熄灯", () => {
    const p = resolveMemberPresence(
      { busyState: "idle", lastTurnOutcome: "ok" },
      null,
      "正在执行",
      NOW,
    );
    expect(p.tone).toBe("done");
  });

  test("两路来源取较新的活动时间：席级陈旧但成员库新鲜 → 绿点", () => {
    const p = resolveMemberPresence(
      { busyState: "idle", lastTurnOutcome: "ok", lastActivityAt: stale },
      { busyState: "idle", lastTurnOutcome: "ok", lastActivityAt: fresh },
      "正在执行",
      NOW,
    );
    expect(p.tone).toBe("done");
  });

  test("runningLabel 透传（跨群忙碌的差异化文案）", () => {
    const p = resolveMemberPresence(
      { busyState: "running" },
      null,
      "正在其他群执行",
      NOW,
    );
    expect(p.label).toBe("正在其他群执行");
  });

  test("配色：黄点用于执行中、绿点用于有新输出（与既有忙碌橙/完成绿同族）", () => {
    expect(PRESENCE_COLOR.running).toBe("#F59E0B");
    expect(PRESENCE_COLOR.done).toBe("#10B981");
  });
});
