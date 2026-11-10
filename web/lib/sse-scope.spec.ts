import { test, expect } from "@playwright/test";
import { matchesScope, type SSEEvent } from "@/hooks/use-sse";

/**
 * matchesScope · 前端 SSE 事件域过滤门（lib-unit）
 * =============================================
 * 背景（2026-11-10 实测缺陷）：A 群会话页底部出现了**另一个群**席位（tmm_…）的
 * 「会话运行中」状态。根因是 `/chat` 切群只改 query 参数、路由不变，React 复用同一
 * TeamSessionView 实例导致状态残留；同时这条断言链（事件是否属于本群）此前没有单测，
 * 任何一侧载荷形状变化都会静默串群。
 *
 * 这里锁住 `team:` 订阅下**跨团队事件必须被丢弃**：
 * - 团队级会话的 `taskId` 是 `team:<teamId>` 伪 scope；
 * - 真实任务事件靠 `payload.taskId === 任务id` 或 `payload.teamId`；
 * - `session.updated` 的载荷只有 {sessionId,status,workerId}，**无法判定归属**，
 *   在 `team:` 域下一律不放行（由页面用 sessionId→席位映射二次过滤）。
 */
const ev = (type: string, payload: unknown): SSEEvent<unknown> => ({
  id: "1",
  type,
  payload,
  timestamp: "2026-11-10T00:00:00.000Z",
});

const TEAM_A = "tm_0000000002";
const TEAM_B = "tm_0000000003";

test("agent.status：本团队伪 scope 放行、他团队丢弃", () => {
  // 团队级会话：worker 回流 taskId 恒为 `team:<teamId>`
  expect(
    matchesScope(ev("agent.status", { taskId: `team:${TEAM_A}`, agentId: "a_tester" }), `team:${TEAM_A}`),
  ).toBe(true);
  expect(
    matchesScope(ev("agent.status", { taskId: `team:${TEAM_B}`, agentId: "a_tester" }), `team:${TEAM_A}`),
  ).toBe(false);
});

test("agent.loading：他团队的伪 scope 同样被丢弃（跨群不得点亮本群状态）", () => {
  expect(
    matchesScope(ev("agent.loading", { taskId: `team:${TEAM_B}`, agentId: "a_tester", phase: "operating" }), `team:${TEAM_A}`),
  ).toBe(false);
});

test("agent.error：他团队丢弃", () => {
  expect(
    matchesScope(ev("agent.error", { taskId: `team:${TEAM_B}`, agentId: "a_tester", error: "boom" }), `team:${TEAM_A}`),
  ).toBe(false);
});

test("taskId 为真实任务 id + 顶层 teamId：按 teamId 判定归属", () => {
  expect(
    matchesScope(ev("agent.status", { taskId: "t_0000000001", teamId: TEAM_A, agentId: "a_tester" }), `team:${TEAM_A}`),
  ).toBe(true);
  expect(
    matchesScope(ev("agent.status", { taskId: "t_0000000001", teamId: TEAM_B, agentId: "a_tester" }), `team:${TEAM_A}`),
  ).toBe(false);
});

test("session.updated：载荷无归属信息，team: 域下不放行（不跨群污染状态表）", () => {
  const payload = { sessionId: "s_x", status: "running", workerId: "w_1" };
  expect(matchesScope(ev("session.updated", payload), `team:${TEAM_A}`)).toBe(false);
  expect(matchesScope(ev("session.updated", payload), "global")).toBe(false);
});

test("chat.message.new：频道事件在 team: 域放行（消息按频道归属，不按团队丢弃）", () => {
  expect(
    matchesScope(ev("chat.message.new", { message: { channelId: "ch_1", senderType: "agent" } }), `team:${TEAM_A}`),
  ).toBe(true);
});

test("global 域只放行 task.status.changed（不含 agent 状态类事件）", () => {
  expect(matchesScope(ev("task.status.changed", { taskId: "t_1" }), "global")).toBe(true);
  expect(matchesScope(ev("agent.status", { taskId: "t_1" }), "global")).toBe(false);
  expect(matchesScope(ev("session.updated", { sessionId: "s_1" }), "global")).toBe(false);
});

test("scope 缺省 / all 放行一切（保持向后兼容）", () => {
  expect(matchesScope(ev("session.updated", { sessionId: "s_1" }), undefined)).toBe(true);
  expect(matchesScope(ev("agent.status", { taskId: `team:${TEAM_B}` }), "all")).toBe(true);
});
