/**
 * 消息处理策略（入站 Webhook 消息过滤/模板/路由）。
 * 按事件从渠道 config.messagePolicies[event] 加载策略；
 * 依赖 field-template.util.ts 的过滤/提取/渲染工具。
 */
import {
  evaluateFilter,
  extractVariables,
  renderMessageTemplate,
  type DeliveryTarget,
  type FilterRule,
  type MessagePolicyConfig,
  type MessagePolicyResult,
  type MessagePolicyVar,
} from './field-template.util';

export type {
  FilterAction,
  FilterCondition,
  FilterOp,
  FilterRule,
  MessagePolicyVar,
  DeliveryTarget,
  MessagePolicyConfig,
  MessagePolicyResult,
} from './field-template.util';

/** 收集 Webhook 入站请求信息（用于投递日志详情，签名/token 脱敏） */
export function collectRequestInfo(req: any): {
  method: string;
  contentType: string | null;
  headers: Record<string, string>;
} {
  const h = req?.headers ?? {};
  const get = (name: string): string | undefined => {
    const v = h[name] ?? h[name.toLowerCase()];
    if (v == null) return undefined;
    return String(Array.isArray(v) ? v[0] : v);
  };
  const mask = (v: string): string =>
    v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : '***';
  const headers: Record<string, string> = {};
  const candidates = [
    'content-type',
    'user-agent',
    'x-gitee-event',
    'x-gitee-token',
    'x-gitee-timestamp',
    'x-gitee-request-id',
    'x-github-event',
    'x-github-delivery',
    'x-hub-signature-256',
    'x-vteam-event',
    'x-vteam-signature',
    'x-vteam-event-id',
  ];
  for (const name of candidates) {
    const v = get(name);
    if (v == null) continue;
    headers[name] = /token|signature|secret/i.test(name) ? mask(v) : v;
  }
  return {
    method: String(req?.method ?? 'POST').toUpperCase(),
    contentType: get('content-type') ?? null,
    headers,
  };
}

/** 丢弃（discard）动作的补充信息 */
export interface MessagePolicySkip {
  reason: string;
  matchedRuleId?: string;
  /** 原始 Webhook JSON（供前端「开始监听」采集测试来源数据） */
  rawPayload?: any;
  /** 请求信息（method/url/headers 脱敏） */
  requestInfo?: any;
}

export interface MessagePolicyExecResult extends MessagePolicyResult {
  /** action='discard' 时返回 skip，caller 当作跳过处理 */
  skip?: MessagePolicySkip;
}

/** 加载事件的消息策略（无配置/策略关闭时返回 null，caller 走旧 fieldMapping 链路） */
export function loadMessagePolicy(
  channel: { config?: any } | null | undefined,
  event: string,
): MessagePolicyConfig | null {
  if (!channel || !event) return null;
  const policies = (channel as any).config?.messagePolicies;
  if (!policies || typeof policies !== 'object' || Array.isArray(policies))
    return null;
  const key = Object.keys(policies).find(
    (k) => k === event || k.toLowerCase() === event.toLowerCase(),
  );
  const policy = key ? policies[key] : undefined;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    return null;
  const cfg = policy as MessagePolicyConfig;
  if (cfg.enabled === false) return null;
  if (!Array.isArray(cfg.filters)) return null;
  if (!Array.isArray(cfg.template?.variables)) return null;
  return cfg;
}

/** 归一化投递目标（防御非对象/缺省/非法字段） */
function normalizeTarget(t: any): DeliveryTarget {
  if (!t || typeof t !== 'object') {
    return { mode: 'teams', teams: [], route: 'main' };
  }
  const teams = Array.isArray(t.teams)
    ? t.teams.filter((x) => typeof x === 'string')
    : [];
  return {
    mode: t.mode === 'member' ? 'member' : 'teams',
    teams,
    member: typeof t.member === 'string' ? t.member : undefined,
    route: t.route === 'mention' ? 'mention' : 'main',
  };
}

/** 执行消息策略：过滤 → 提取变量 → 渲染模板 → 计算投递目标 */
export function executeMessagePolicy(
  policy: MessagePolicyConfig,
  event: string,
  data: any,
): MessagePolicyExecResult {
  const deliveryTarget = normalizeTarget(policy.targets);
  const filters = policy.filters ?? [];
  const defaultAction =
    policy.defaultAction === 'discard' ? 'discard' : 'deliver';
  const variables: MessagePolicyVar[] = policy.template?.variables ?? [];
  const content =
    typeof policy.template?.content === 'string' ? policy.template.content : '';

  const { action, matchedRule } = evaluateFilter(filters, defaultAction, data);
  if (action === 'discard') {
    return {
      action,
      variables: {},
      rendered: '',
      deliveryTarget,
      skip: {
        reason: '过滤规则丢弃该消息',
        matchedRuleId: matchedRule?.id ?? undefined,
      },
    };
  }
  const extracted = extractVariables(variables, data);
  const rendered = renderMessageTemplate(content, variables, data);
  return {
    action,
    matchedRule,
    variables: extracted,
    rendered,
    deliveryTarget,
  };
}

/** 便捷：load + execute 一步到位（无策略返回 null） */
export function runMessagePolicy(
  channel: { config?: any } | null | undefined,
  event: string,
  data: any,
): MessagePolicyExecResult | null {
  const policy = loadMessagePolicy(channel, event);
  if (!policy) return null;
  return executeMessagePolicy(policy, event, data);
}

/** 策略 → 入站指令表现（三个 adapter 共用），null 表示未处理（回退旧 fieldMapping 链路） */
export interface PolicyInboundResult {
  skip?: MessagePolicySkip;
  deliver?: {
    text: string;
    senderName?: string;
    deliveryMeta: Record<string, any>;
  };
}

/**
 * 按事件加载消息策略并构建入站结果：
 * - skip：策略命中 discard → adapter 返回 skip 指令
 * - deliver：策略放行且模板有内容 → adapter 返回带 deliveryMeta 的 post_message
 * - null：无策略（或政策放行但模板为空→回退旧链路）
 */
export function buildPolicyInbound(
  channel: { config?: any } | null | undefined,
  event: string,
  data: any,
  dedupKey?: string,
  req?: any,
): PolicyInboundResult | null {
  const r = runMessagePolicy(channel, event, data);
  if (!r) return null;
  const requestInfo = req ? collectRequestInfo(req) : undefined;
  if (r.skip) {
    return { skip: { ...r.skip, rawPayload: data, requestInfo } };
  }
  if (!r.rendered) {
    return null;
  }
  return {
    deliver: {
      text: r.rendered,
      senderName: r.variables.user || undefined,
      deliveryMeta: {
        event,
        matchedRuleId: r.matchedRule?.id ?? null,
        action: r.action,
        variables: r.variables,
        deliveryTarget: r.deliveryTarget,
        rendered: r.rendered,
        rawPayload: data,
        requestInfo,
      },
    },
  };
}
