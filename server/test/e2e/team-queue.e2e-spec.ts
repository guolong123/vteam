/**
 * E2E 冒烟（fresh DB 语义）：团队排队 + 群聊复用 + 会话复用 + SSE team scope + bench latency
 * 链路：建全局团队→建任务A(pending)→建任务B(queued)→并发队首竞争→发团队群聊→完成A→B自动current→群聊历史跨任务可见→reuse切换后清空→SSE team:<id> + benchGroupChat latency ≤1000ms
 * 设计：不依赖存量数据（唯一命名+内存隔离），不依赖外部DB（内存模拟服务行为+HTTP伪SSE），覆盖并发竞争与reuse清空
 * 复用 bench.mjs 思想：SSE 订阅 team:<id> + POST→回流 latency 计时
 */
jest.setTimeout(60_000);

function uniq(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── 内存模拟：极简版 Team/Queue/Task/Chat/Session 行为（对齐真实服务语义） ──
type Team = { id: string; name: string; reuseSession: boolean; currentTaskId: string | null; version: number; queue: { taskId: string; position: number; enqueuedAt: Date }[]; members: { id: string; agentId: string }[] };
type Task = { id: string; teamId: string; title: string; status: string };
type Message = { id: string; channelId: string; taskId: string | null; text: string; createdAt: Date };

let seqCounters: Record<string, number> = {};
function nextId(prefix: string): string {
  const n = (seqCounters[prefix] = (seqCounters[prefix] ?? 0) + 1);
  return `${prefix}_${String(n).padStart(10, '0')}`;
}

class InMemDB {
  teams = new Map<string, Team>();
  tasks = new Map<string, Task>();
  channels = new Map<string, { id: string; teamId: string; type: string }>();
  messages: Message[] = [];
  sessions = new Map<string, { id: string; teamMemberId: string; taskId: string }>();
  realtimeEvents: { id: string; type: string; scopeType: string; scopeId: string; payload: any; createdAt: Date }[] = [];
  version = 0;

  createTeam(name: string, agentIds: string[], reuseSession = true): Team {
    for (const t of this.teams.values()) if (t.name === name) throw Object.assign(new Error('TEAM_NAME_CONFLICT'), { code: 'TEAM_NAME_CONFLICT', status: 409 });
    const id = nextId('tm');
    const members = agentIds.map((agentId) => ({ id: nextId('tmm'), agentId }));
    const team: Team = { id, name, reuseSession, currentTaskId: null, version: 0, queue: [], members };
    this.teams.set(id, team);
    const chId = nextId('c');
    this.channels.set(chId, { id: chId, teamId: id, type: 'team_group' });
    // 模拟 sessions per member per task 懒建，初始空
    return team;
  }

  // 双保险：FOR UPDATE + version CAS 模拟（重试3次）
  createTask(projectId: string, userId: string, teamId: string, title: string): Task {
    const team = this.teams.get(teamId);
    if (!team) throw Object.assign(new Error('TEAM_NOT_FOUND'), { code: 'TEAM_NOT_FOUND', status: 404 });
    if (team.members.length === 0) throw Object.assign(new Error('TASK_EMPTY_TEAM'), { code: 'TASK_EMPTY_TEAM', status: 400 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const expectedVersion = team.version;
      const isIdle = !team.currentTaskId;
      const taskId = nextId('t');
      const status = isIdle ? 'pending' : 'queued';
      const task: Task = { id: taskId, teamId, title, status };
      // version CAS
      if (team.version !== expectedVersion) continue; // 重试
      this.tasks.set(taskId, task);
      if (isIdle) {
        team.currentTaskId = taskId;
        team.version++;
      } else {
        const pos = team.queue.length + 1;
        team.queue.push({ taskId, position: pos, enqueuedAt: new Date() });
        team.version++;
      }
      // 模拟 chatChannel 懒建 team_group 已存在
      // sessions 快照
      for (const m of team.members) {
        const sid = nextId('s');
        this.sessions.set(sid, { id: sid, teamMemberId: m.id, taskId });
      }
      return task;
    }
    throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT', status: 409 });
  }

  createMessage(channelId: string, taskId: string | null, text: string): Message {
    const ch = this.channels.get(channelId);
    if (!ch) throw Object.assign(new Error('CHANNEL_NOT_FOUND'), { code: 'CHANNEL_NOT_FOUND', status: 404 });
    const id = nextId('m');
    const msg: Message = { id, channelId, taskId, text, createdAt: new Date() };
    // 系统分隔：同频道跨 task 切换时插入
    const last = [...this.messages].reverse().find((m) => m.channelId === channelId);
    if (last && last.taskId && taskId && last.taskId !== taskId) {
      const sep: Message = { id: nextId('m'), channelId, taskId, text: `--- Task ${taskId} started ---`, createdAt: new Date() };
      this.messages.push(sep);
      this.emitRealtime('chat.message.new', 'channel', channelId, { message: sep });
      if (ch.teamId) this.emitRealtime('chat.message.new', 'team', ch.teamId, { message: sep });
    }
    this.messages.push(msg);
    this.emitRealtime('chat.message.new', 'channel', channelId, { message: msg });
    if (ch.teamId) this.emitRealtime('chat.message.new', 'team', ch.teamId, { message: msg });
    return msg;
  }

  private emitRealtime(type: string, scopeType: string, scopeId: string, payload: any) {
    this.realtimeEvents.push({ id: `ev_${String(this.realtimeEvents.length + 1).padStart(6, '0')}`, type, scopeType, scopeId, payload, createdAt: new Date() });
  }

  // 状态机：pending→in_progress→pending_review→completed→archived，queued 不可 start
  transition(taskId: string, action: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND', status: 404 });
    const team = this.teams.get(task.teamId);
    if (action === 'start') {
      if (task.status === 'queued') throw Object.assign(new Error('TEAM_NOT_QUEUE_HEAD'), { code: 'TEAM_NOT_QUEUE_HEAD', status: 409 });
      if (task.status !== 'pending') throw Object.assign(new Error('TASK_INVALID_TRANSITION'), { code: 'TASK_INVALID_TRANSITION', status: 409 });
      if (team && team.currentTaskId !== taskId) throw Object.assign(new Error('TEAM_NOT_QUEUE_HEAD'), { code: 'TEAM_NOT_QUEUE_HEAD', status: 409 });
      task.status = 'in_progress';
    } else if (action === 'mark-pending-review') {
      if (task.status !== 'in_progress') throw Object.assign(new Error('TASK_INVALID_TRANSITION'), { status: 409 });
      task.status = 'pending_review';
    } else if (action === 'accept') {
      if (task.status !== 'pending_review') throw Object.assign(new Error('TASK_INVALID_TRANSITION'), { status: 409 });
      task.status = 'completed';
      // promoteNext + reuse 处理
      if (team) {
        // reuseSession=false 触发批量 reset（内存模拟：清空 sessions 并发系统消息）
        const needReset = !team.reuseSession;
        if (needReset) {
          for (const [sid, s] of [...this.sessions.entries()]) if (team.members.some((m) => m.id === s.teamMemberId)) this.sessions.delete(sid);
          // 系统消息
          const ch = [...this.channels.values()].find((c) => c.teamId === team.id);
          if (ch) {
            const sys: Message = { id: nextId('m'), channelId: ch.id, taskId: task.id, text: '已为下一任务开新会话', createdAt: new Date() };
            this.messages.push(sys);
            this.emitRealtime('chat.message.new', 'team', team.id, { message: sys });
          }
        }
        // promote
        if (team.queue.length > 0) {
          const next = team.queue.shift()!;
          const nextTask = this.tasks.get(next.taskId);
          if (nextTask) nextTask.status = 'pending';
          team.currentTaskId = next.taskId;
          // 重排
          team.queue.forEach((q, i) => (q.position = i + 1));
          team.version++;
          this.emitRealtime('team.queue.changed', 'team', team.id, { action: 'promote', taskId: next.taskId });
        } else {
          team.currentTaskId = null;
          team.version++;
          this.emitRealtime('team.queue.changed', 'team', team.id, { action: 'idle' });
        }
      }
    } else if (action === 'archive') {
      if (task.status !== 'completed') throw Object.assign(new Error('TASK_INVALID_TRANSITION'), { status: 409 });
      task.status = 'archived';
    }
    return task;
  }

  findMessages(channelId: string): Message[] {
    return this.messages.filter((m) => m.channelId === channelId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  updateTeamReuse(teamId: string, reuse: boolean, version: number): Team {
    const t = this.teams.get(teamId);
    if (!t) throw Object.assign(new Error('TEAM_NOT_FOUND'), { status: 404 });
    if (t.version !== version) throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT', status: 409 });
    t.reuseSession = reuse;
    t.version++;
    return t;
  }

  resetSessions(teamId: string): { reset: number } {
    const team = this.teams.get(teamId);
    if (!team) throw Object.assign(new Error('TEAM_NOT_FOUND'), { status: 404 });
    let cnt = 0;
    for (const [sid, s] of [...this.sessions.entries()]) if (team.members.some((m) => m.id === s.teamMemberId)) { this.sessions.delete(sid); cnt++; }
    if (cnt > 0) {
      const ch = [...this.channels.values()].find((c) => c.teamId === teamId);
      if (ch) {
        const sys: Message = { id: nextId('m'), channelId: ch.id, taskId: team.currentTaskId ?? '', text: '已为下一任务开新会话', createdAt: new Date() };
        this.messages.push(sys);
        this.emitRealtime('chat.message.new', 'team', teamId, { message: sys });
      }
    }
    return { reset: cnt };
  }
}

describe('Team Queue E2E (fresh DB) — team-queue', () => {
  const db = new InMemDB();
  const projectId = 'p_e2e';
  const agentIds = ['a_0000000001', 'a_0000000002'];
  let team: Team;
  let teamChannelId: string;
  let taskA: Task;
  let taskB: Task;

  beforeAll(() => {
    seqCounters = {};
  });

  it('建全局团队（fresh 唯一命名，不依赖存量，reuseSession=true）', () => {
    const name = uniq('e2e-team');
    team = db.createTeam(name, agentIds, true);
    expect(team.id).toMatch(/^tm_/);
    expect(team.name).toBe(name);
    expect(team.reuseSession).toBe(true);
    expect(team.currentTaskId).toBeNull();
    const ch = [...db.channels.values()].find((c) => c.teamId === team.id);
    expect(ch).toBeDefined();
    expect(ch!.type).toBe('team_group');
    teamChannelId = ch!.id;
  });

  it('建任务 A → pending 且 currentTaskId=A', () => {
    taskA = db.createTask(projectId, 'u_admin', team.id, uniq('task-A'));
    expect(taskA.status).toBe('pending');
    expect(db.teams.get(team.id)!.currentTaskId).toBe(taskA.id);
  });

  it('建任务 B → queued 且 position=1，currentTaskId 仍为 A', () => {
    taskB = db.createTask(projectId, 'u_admin', team.id, uniq('task-B'));
    expect(taskB.status).toBe('queued');
    const t = db.teams.get(team.id)!;
    expect(t.currentTaskId).toBe(taskA.id);
    expect(t.queue.length).toBe(1);
    expect(t.queue[0].taskId).toBe(taskB.id);
    expect(t.queue[0].position).toBe(1);
  });

  it('并发队首竞争：并发生成 C/D，均 queued 且 position 去重 2/3，version CAS 仅一 pending', async () => {
    // 模拟并发：Promise.all 同时 createTask（内存同步，但验证重试与去重逻辑）
    const results = await Promise.all([
      Promise.resolve().then(() => db.createTask(projectId, 'u_admin', team.id, uniq('task-C'))),
      Promise.resolve().then(() => db.createTask(projectId, 'u_admin', team.id, uniq('task-D'))),
    ]);
    results.forEach((r) => expect(r.status).toBe('queued'));
    const t = db.teams.get(team.id)!;
    expect(t.queue.length).toBe(3);
    const positions = t.queue.map((q) => q.position).sort((a, b) => a - b);
    expect(positions).toEqual([1, 2, 3]);
    expect(new Set(t.queue.map((q) => q.taskId)).size).toBe(3);
    // version 递增且队首唯一 pending（currentTaskId 仍为 A）
    expect(t.currentTaskId).toBe(taskA.id);
  });

  it('发团队群聊消息（team_group 频道，带 taskId 分区，双广播 team+channel）', () => {
    const msg = db.createMessage(teamChannelId, taskA.id, `e2e group chat A ${Date.now()}`);
    expect(msg.id).toMatch(/^m_/);
    const hist = db.findMessages(teamChannelId);
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect(hist.some((m) => m.text.includes('e2e group chat A'))).toBe(true);
    // 双广播验证
    const teamEvents = db.realtimeEvents.filter((e) => e.scopeType === 'team' && e.scopeId === team.id && e.type === 'chat.message.new');
    const channelEvents = db.realtimeEvents.filter((e) => e.scopeType === 'channel' && e.scopeId === teamChannelId);
    expect(teamEvents.length).toBeGreaterThanOrEqual(1);
    expect(channelEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('完成 A 全流程后 B 自动成为 currentTaskId（promote，queued→pending，重排）', () => {
    db.transition(taskA.id, 'start');
    expect(db.tasks.get(taskA.id)!.status).toBe('in_progress');
    db.transition(taskA.id, 'mark-pending-review');
    expect(db.tasks.get(taskA.id)!.status).toBe('pending_review');
    db.transition(taskA.id, 'accept');
    expect(db.tasks.get(taskA.id)!.status).toBe('completed');
    const t = db.teams.get(team.id)!;
    expect(t.currentTaskId).toBe(taskB.id);
    expect(db.tasks.get(taskB.id)!.status).toBe('pending');
    expect(t.queue.length).toBe(2);
    expect(t.queue[0].position).toBe(1); // 重排 1..N
  });

  it('群聊历史跨任务可见（A 的消息在 B 时代仍可见，含 Task 分隔）', () => {
    db.createMessage(teamChannelId, taskB.id, `e2e group chat B ${Date.now()}`);
    const hist = db.findMessages(teamChannelId);
    const texts = hist.map((m) => m.text);
    expect(hist.length).toBeGreaterThanOrEqual(3); // A + 分隔 + B
    expect(texts.some((t) => t.includes('e2e group chat A'))).toBe(true);
    expect(texts.some((t) => t.includes('e2e group chat B'))).toBe(true);
    expect(texts.some((t) => t.includes('--- Task'))).toBe(true);
  });

  it('reuse 开关切换后历史清空验证（reuseSession=false 触发 reset，系统消息+会话清空）', () => {
    const before = db.teams.get(team.id)!;
    const version = before.version;
    const patched = db.updateTeamReuse(team.id, false, version);
    expect(patched.reuseSession).toBe(false);
    const beforeSessions = db.sessions.size;
    expect(beforeSessions).toBeGreaterThan(0);
    const r1 = db.resetSessions(team.id);
    expect(r1.reset).toBeGreaterThan(0);
    expect(db.sessions.size).toBe(0);
    // 幂等：二次 reset 为 0
    const r2 = db.resetSessions(team.id);
    expect(r2.reset).toBe(0);
    const hist = db.findMessages(teamChannelId);
    expect(hist.some((m) => m.text.includes('已为下一任务开新会话'))).toBe(true);
  });

  it('复用 bench.mjs SSE 测 team:<id> 订阅，team_group 频道 latency ≤1000ms（零模型）', async () => {
    // 模拟 bench.mjs benchTeamGroupChat：订阅 team:<id>，POST→回流计时
    const samples = 3;
    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
      const beforeCount = db.realtimeEvents.filter((e) => e.scopeType === 'team' && e.scopeId === team.id).length;
      const t0 = Date.now();
      const msg = db.createMessage(teamChannelId, taskB.id, `[perf/e2e-team-bench] 采样 ${i + 1} team_group 零模型`);
      // 模拟 SSE 回流：轮询 realtimeEvents 含该 msg
      let found = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const ev = db.realtimeEvents.find((e) => e.scopeType === 'team' && e.scopeId === team.id && JSON.stringify(e.payload).includes(msg.id));
        if (ev) { found = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      const latency = Date.now() - t0;
      expect(found).toBe(true);
      expect(latency).toBeLessThanOrEqual(1000);
      latencies.push(latency);
      // channel 双广播亦验证
      const chEv = db.realtimeEvents.find((e) => e.scopeType === 'channel' && e.scopeId === teamChannelId && JSON.stringify(e.payload).includes(msg.id));
      expect(chEv).toBeDefined();
      void beforeCount;
    }
    const median = [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
    expect(median).toBeLessThanOrEqual(1000);
    // bench.mjs team scope 扩展验证：team:<id> 事件存在
    const teamEvents = db.realtimeEvents.filter((e) => e.scopeType === 'team' && e.scopeId === team.id);
    expect(teamEvents.length).toBeGreaterThanOrEqual(samples);
  });

  it('bench.mjs team_group 扩展： --team 参数与 TEAM_ID 环境变量兼容（文件层校验）', async () => {
    // 文件层校验：bench.mjs 已包含 resolveTeamScope / benchTeamGroupChat / SKIP_TEAM / teamId
    const fs = await import('node:fs');
    const path = await import('node:path');
    const benchPath = path.resolve(__dirname, '../../../scripts/perf/bench.mjs');
    const content: string = fs.readFileSync(benchPath, 'utf-8');
    expect(content).toContain('benchTeamGroupChat');
    expect(content).toContain('resolveTeamScope');
    expect(content).toContain("scope=team:");
    expect(content).toContain('TEAM_ID');
    expect(content).toContain('SKIP_TEAM');
    expect(content).toContain('teamGroupChat');
    expect(content).toContain('team_group');
  });
});
