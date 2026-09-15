import {
  getOpencodeAgentDuty,
  listExecuteDutyAgents,
  listPlanDutyAgents,
} from './opencode-agent-duty';

describe('opencode agent 职责约定（计划/执行一对一映射）', () => {
  it('约定计划职责：plan（原生）/ prometheus（OmO）', () => {
    expect(getOpencodeAgentDuty('plan')).toBe('plan');
    expect(getOpencodeAgentDuty('prometheus')).toBe('plan');
    expect(listPlanDutyAgents()).toEqual(
      expect.arrayContaining(['plan', 'prometheus']),
    );
  });

  it('Todo 13：vteam-plan 为计划职责（策略 agent 计划侧候选）', () => {
    expect(getOpencodeAgentDuty('vteam-plan')).toBe('plan');
    expect(listPlanDutyAgents()).toEqual(
      expect.arrayContaining(['plan', 'prometheus', 'vteam-plan']),
    );
  });

  it('Todo 13：vteam-<role> 均为执行职责（仅 vteam-plan 进计划集，含只读 vteam-librarian）', () => {
    for (const name of [
      'vteam-product',
      'vteam-architect',
      'vteam-developer',
      'vteam-tester',
      'vteam-project_manager',
      'vteam-librarian',
    ]) {
      expect(getOpencodeAgentDuty(name)).toBe('execute');
    }
    expect(listPlanDutyAgents()).not.toContain('vteam-developer');
  });

  it('约定执行职责：build / atlas', () => {
    expect(getOpencodeAgentDuty('build')).toBe('execute');
    expect(getOpencodeAgentDuty('atlas')).toBe('execute');
    expect(listExecuteDutyAgents()).toEqual(
      expect.arrayContaining(['build', 'atlas']),
    );
  });

  it('OmO 的非计划 agent 一律按 execute（不凭名字猜职责）', () => {
    for (const name of [
      'sisyphus',
      'hephaestus',
      'sisyphus-junior',
      'oracle',
      'librarian',
      'explore',
      'multimodal-looker',
      'metis',
      'momus',
    ]) {
      expect(getOpencodeAgentDuty(name)).toBe('execute');
    }
  });

  it('orchestrator 不属本表（那是 oh-my-opencode-slim 的 agent，不在 OmO 里）', () => {
    expect(getOpencodeAgentDuty('orchestrator')).toBe('execute');
    expect(listPlanDutyAgents()).not.toContain('orchestrator');
  });

  it('null/空/未知名 → execute（默认安全：不改变现有行为；未知计划 agent 走显式 planMode 开关）', () => {
    expect(getOpencodeAgentDuty(null)).toBe('execute');
    expect(getOpencodeAgentDuty(undefined)).toBe('execute');
    expect(getOpencodeAgentDuty('  ')).toBe('execute');
    expect(getOpencodeAgentDuty('my-custom-fixer')).toBe('execute');
    expect(getOpencodeAgentDuty('oracle')).toBe('execute');
  });

  it('首尾空格容忍', () => {
    expect(getOpencodeAgentDuty('  plan  ')).toBe('plan');
    expect(getOpencodeAgentDuty(' prometheus ')).toBe('plan');
  });
});

describe('OmO 展示名（"<Name> - <描述>"）的职责判定', () => {
  it('OmO primary agent 展示名命中正确职责（回归：整串精确匹配会全部落 execute）', () => {
    // 实测 opencode GET /agent 返回的就是这些展示名
    expect(getOpencodeAgentDuty('Prometheus - Plan Builder')).toBe('plan');
    expect(getOpencodeAgentDuty('Sisyphus - ultraworker')).toBe('execute');
    expect(getOpencodeAgentDuty('Hephaestus - Deep Agent')).toBe('execute');
  });

  it('大小写与空格容忍', () => {
    expect(getOpencodeAgentDuty('prometheus - plan builder')).toBe('plan');
    expect(getOpencodeAgentDuty('  Prometheus - Plan Builder  ')).toBe('plan');
  });

  it('不需要模糊包含：用户自定义的相似名不被误判', () => {
    expect(getOpencodeAgentDuty('my-prometheus-helper')).toBe('execute');
    expect(getOpencodeAgentDuty('prometheus2')).toBe('execute');
  });

  it('原生裸名与 OmO 展示名都能命中（同一张表）', () => {
    expect(getOpencodeAgentDuty('plan')).toBe('plan');
    expect(getOpencodeAgentDuty('Prometheus - Plan Builder')).toBe('plan');
    expect(getOpencodeAgentDuty('build')).toBe('execute');
  });
});
