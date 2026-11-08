/**
 * 成员默认中文姓名生成（种子与新建共用规则）。
 *
 * 规则：<姓><中文序号><岗位末字>，例如开发者第 1 位 = 胡一开、第 2 位 = 胡二开。
 * 岗位 key 取 AgentRole.key（product/project_manager/architect/developer/tester/plan/librarian）。
 */
const NAME_PARTS: Record<string, { surname: string; tail: string }> = {
  product: { surname: '苏', tail: '产' },
  project_manager: { surname: '周', tail: '项' },
  architect: { surname: '林', tail: '架' },
  developer: { surname: '胡', tail: '开' },
  tester: { surname: '秦', tail: '测' },
  plan: { surname: '许', tail: '计' },
  librarian: { surname: '文', tail: '知' },
};

const CN_NUM = [
  '零',
  '一',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '十',
];

export function cnNumber(n: number): string {
  if (n <= 10) return CN_NUM[n] ?? String(n);
  if (n < 20) return `十${CN_NUM[n - 10] ?? ''}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${CN_NUM[tens] ?? tens}十${ones ? (CN_NUM[ones] ?? ones) : ''}`.replace(
    '二十',
    '二十',
  );
}

/** 按岗位 key + 序号生成默认姓名；未知岗位回退「成<序号>员」。 */
export function defaultMemberName(roleKey: string, seq: number): string {
  const parts = NAME_PARTS[roleKey];
  const n = Math.max(1, Math.floor(seq));
  if (!parts) return `成${cnNumber(n)}员`;
  return `${parts.surname}${cnNumber(n)}${parts.tail}`;
}
