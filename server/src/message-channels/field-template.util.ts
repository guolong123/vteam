/**
 * 字段模板渲染工具（generic/github/gitee 共用）。
 * 模板内 {{ path }} 按 data 对象路径提取，缺失返回空串。
 * 支持：
 * - 点号路径 a.b.c
 * - 括号索引 a[0].b / commits[0].message / a.b[0].c
 * - 多级括号 a[0][1]
 * per-event fieldMappings 依赖此工具将 payload 不同事件的字段映射为统一 InboundCommand。
 *
 * 扩展（Webhook 消息过滤/模板）：
 * - extractVariables：按变量表（name←path+fallback）提取（缺失回退 fallback）
 * - renderMessageTemplate：按变量表渲染 {{name}} 插值（纯插值，无脚本）
 * - evaluateFilter：过滤规则评估（条件 AND/OR + 命中动作 deliver/discard）
 * - getJsonValue：导出的路径取值（供其他模块复用）
 */

export function get(data: any, path: string): any {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: any = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    // Normalize bracket notation: commits[0] -> commits.0 , a[0][1] -> a.0.1
    const normalized = p.replace(/\[(\d+)\]/g, '.$1');
    const subParts = normalized.split('.');
    for (const sp of subParts) {
      if (sp === '') continue;
      if (cur == null) return undefined;
      if (Array.isArray(cur) && /^\d+$/.test(sp)) {
        cur = cur[Number(sp)];
      } else {
        cur = cur[sp];
      }
      if (cur === undefined) return undefined;
    }
  }
  return cur;
}

/** 导出路径取值（供消息策略/条件评估复用）。 */
export function getJsonValue(data: any, path: string): any {
  return get(data, path);
}

function stringify(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return String(v);
  } catch {
    return '';
  }
}

export function renderFieldTemplate(template: string, data: any): string {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => {
    const v = get(data, (path as string).trim());
    if (v == null) return '';
    return stringify(v);
  });
}

/* ----------------------------- 过滤/提取/模板/策略（扩展） ----------------------------- */

/** 过滤命中动作：deliver=放行，discard=丢弃 */
export type FilterAction = 'deliver' | 'discard';

/** 过滤条件运算符 */
export type FilterOp = 'eq' | 'neq' | 'contains' | 'regex' | 'exists' | 'in';

/** 过滤条件：path（如 issue.state）+ op + value（op 为 exists 时忽略 value） */
export interface FilterCondition {
  path: string;
  op: FilterOp;
  value?: string;
}

/** 过滤规则：条件内部 AND/OR，首条命中即生效（数组顺序=优先级） */
export interface FilterRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  logic: 'and' | 'or';
  conditions: FilterCondition[];
  action: FilterAction;
}

/** 消息模板变量：name←path，缺失时用 fallback */
export interface MessagePolicyVar {
  name: string;
  path: string;
  fallback?: string;
}

/** 投递目标（渠道级绑定，互斥）：
 * - teams：绑定团队群聊 id 列表（每团队一个群，多选，空 = 沿用渠道现有绑定）
 * - member：绑定成员私聊 id（唯一成员；与 teams 互斥）
 * - route：群模式下的消息接入方式（路由到主 Agent / 消息带 @Agent名 mention 路由）
 */
export interface DeliveryTarget {
  mode: 'teams' | 'member';
  teams: string[];
  member?: string;
  route: 'main' | 'mention';
}

/** 消息处理策略（config.messagePolicies[event]），与 fieldMappings 同构结构风格 */
export interface MessagePolicyConfig {
  enabled?: boolean;
  defaultAction: FilterAction;
  filters: FilterRule[];
  template: {
    variables: MessagePolicyVar[];
    content: string;
  };
  targets: DeliveryTarget;
}

/** 消息策略执行结果 */
export interface MessagePolicyResult {
  action: FilterAction;
  matchedRule?: FilterRule;
  variables: Record<string, string>;
  rendered: string;
  deliveryTarget: DeliveryTarget;
}

/** 按变量表从 data 提取变量值（缺失回退 fallback） */
export function extractVariables(
  vars: MessagePolicyVar[],
  data: any,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars ?? []) {
    const raw = get(data, v.path);
    out[v.name] =
      raw === undefined || raw === null || raw === ''
        ? (v.fallback ?? '')
        : stringify(raw);
  }
  return out;
}

/** 按变量表渲染 {{name}} 插值（纯插值，不解析 JS 表达式） */
export function renderMessageTemplate(
  template: string,
  vars: MessagePolicyVar[],
  data: any,
): string {
  const map = extractVariables(vars, data);
  return (template ?? '').replace(
    /\{\{\s*([^}]+)\s*\}\}/g,
    (_, key: string) => map[key.trim()] ?? '',
  );
}

function matchesCondition(cond: FilterCondition, data: any): boolean {
  const raw = get(data, cond.path);
  if (cond.op === 'exists') return raw !== undefined && raw !== null;
  const value = String(raw ?? '');
  switch (cond.op) {
    case 'eq':
      return value === (cond.value ?? '');
    case 'neq':
      return value !== (cond.value ?? '');
    case 'contains':
      return value.includes(cond.value ?? '');
    case 'regex': {
      try {
        return new RegExp(cond.value ?? '').test(value);
      } catch {
        return false;
      }
    }
    case 'in': {
      const list = (cond.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return list.includes(value);
    }
    default:
      return false;
  }
}

/** 过滤评估：数组顺序=优先级，首条命中；未命中用默认动作 */
export function evaluateFilter(
  rules: FilterRule[],
  defaultAction: FilterAction,
  data: any,
): { action: FilterAction; matchedRule?: FilterRule } {
  for (const rule of rules ?? []) {
    if (rule.enabled === false) continue;
    const conditions = rule.conditions ?? [];
    if (conditions.length === 0) continue;
    const results = conditions.map((c) => matchesCondition(c, data));
    const ok =
      rule.logic === 'and' ? results.every(Boolean) : results.some(Boolean);
    if (ok) return { action: rule.action, matchedRule: rule };
  }
  return { action: defaultAction };
}
