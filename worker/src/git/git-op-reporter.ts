/**
 * T6 git.op 审计上报（17 篇 §8.2：git 操作落 task_events，eventType=git.op）。
 *
 * 上报路径（spike 结论，方案 B）：worker 复用现有 GET /session/{id}/message 轮询
 * （awaitCompletion），从返回的 messages parts 中检测 `type === "tool"` 且
 * `tool` 以 git_ 前缀（git_clone/git_pull/...）的 ToolPart（SDK 类型含
 * callID + state{status,input,output,error,time}）。工具执行在 opencode 插件
 * 进程内完成，worker 无需侵入插件即可感知执行时机与结果。
 *
 * taskId 来源：GitOpReporter 在创建时从会话执行上下文（worker 进程内已知）注入，
 * 挂载到 awaitCompletion 的 onPoll 回调即可随轮询驱动（T10 会话执行接线点）。
 *
 * exit code 映射：state.status=completed → 0；error → 从错误消息提取 `exit N`，
 * 无则记 1（git 命令以非零状态退出，runGit throw 消息含 exit 码）。
 */

import { EventSender } from '../client/event-client';
import { ServeMessage, ServePart } from '../driver/v1-driver';
import { WORKER_EVENT_TYPES } from '../protocol/worker-protocol';

/** 单条 git 工具执行审计记录（从 ToolPart 提取）。 */
export interface GitOpRecord {
  /** 去重键：ToolPart.callID（每次工具调用唯一）。 */
  callID: string;
  /** 工具名（如 git_clone），即权限 action。 */
  action: string;
  /** 仓库地址（state.input.repo_url，非 git 工具可缺省）。 */
  repoUrl?: string;
  /** 退出码：completed → 0；error → 提取 exit N 或 1。 */
  exit: number;
  /** error 状态时的失败消息。 */
  error?: string;
  /** 执行开始时间戳 ms（state.time.start）。 */
  startedAt?: number;
  /** 执行结束时间戳 ms（state.time.end）。 */
  endedAt?: number;
}

/** ToolPart 的 state 字段（SDK ToolState 宽松视图，规避类型依赖）。 */
interface ToolStateView {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start?: number; end?: number };
}

function extractExitCode(status: string, error: string | undefined): number {
  if (status === 'completed') {
    return 0;
  }
  const m = /exit[= ](\d+)/.exec(error ?? '');
  return m ? Number(m[1]) : 1;
}

/**
 * 从 serve messages 提取 git 工具终态记录（纯函数，测试友好）。
 * 只取 status=completed/error 的终态 part；pending/running 中间态跳过
 * （轮询全量累积列表，同一 callID 会逐步演变，终态出现一次后不再变化）。
 */
export function extractGitOps(messages: ServeMessage[]): GitOpRecord[] {
  const records: GitOpRecord[] = [];
  for (const m of messages) {
    for (const part of m.parts ?? []) {
      if (part.type !== 'tool') {
        continue;
      }
      const tool = (part as ServePart & { tool?: unknown }).tool;
      if (typeof tool !== 'string' || !tool.startsWith('git_')) {
        continue;
      }
      const state = (part as ServePart & { state?: unknown }).state as
        | ToolStateView
        | undefined;
      const status = state?.status;
      if (status !== 'completed' && status !== 'error') {
        continue;
      }
      const input = state?.input ?? {};
      const error = status === 'error' ? state?.error : undefined;
      const rawCallID = (part as ServePart & { callID?: unknown }).callID;
      records.push({
        callID:
          typeof rawCallID === 'string'
            ? rawCallID
            : `${tool}-${part.id ?? ''}`,
        action: tool,
        ...(typeof input.repo_url === 'string'
          ? { repoUrl: input.repo_url }
          : {}),
        exit: extractExitCode(status, error),
        ...(error ? { error } : {}),
        ...(state?.time?.start !== undefined
          ? { startedAt: state.time.start }
          : {}),
        ...(state?.time?.end !== undefined ? { endedAt: state.time.end } : {}),
      });
    }
  }
  return records;
}

export interface GitOpReporterOptions {
  /** 平台 Task 主键（t_ 前缀），会话执行上下文带出。 */
  taskId: string;
  /** Agent id（a_ 前缀），审计 actor。 */
  agentId?: string;
  /** 平台 Session 主键（s_ 前缀）。 */
  sessionId?: string;
  /** 事件上送通道（进程内 EventSender 单例）。 */
  sender: EventSender;
}

/**
 * 轮询消息 → git.op 上报（按 callID 去重，只报终态一次）。
 * 挂载方式：awaitCompletion({ onPoll: (messages) => reporter.scan(messages) })。
 */
export class GitOpReporter {
  private readonly reported = new Set<string>();

  constructor(private readonly opts: GitOpReporterOptions) {}

  /** 扫描一批 messages，发现新的 git 终态记录即上报（失败不抛，EventSender 兜底）。 */
  async scan(messages: ServeMessage[]): Promise<void> {
    const fresh = extractGitOps(messages).filter(
      (r) => !this.reported.has(r.callID),
    );
    for (const r of fresh) {
      this.reported.add(r.callID);
    }
    await Promise.all(
      fresh.map((r) =>
        this.opts.sender.send(WORKER_EVENT_TYPES.GIT_OP, {
          taskId: this.opts.taskId,
          ...(this.opts.agentId ? { agentId: this.opts.agentId } : {}),
          ...(this.opts.sessionId ? { sessionId: this.opts.sessionId } : {}),
          action: r.action,
          ...(r.repoUrl ? { repo_url: r.repoUrl } : {}),
          exit: r.exit,
          ...(r.error ? { error: r.error } : {}),
        }),
      ),
    );
  }
}
