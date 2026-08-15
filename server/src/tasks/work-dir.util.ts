/**
 * is_0000000010：工作目录名 sanitize——agent 名称可能含中文/空格/斜杠等，做安全映射：
 * 保留字母数字下划线、点、连字符与 CJK 字符（Linux/UTF-8 支持中文目录，需求「与 agent
 * 名称同名」），其余非法字符（空格/斜杠/引号/路径分隔符等）→ `-`；去首尾连字符/点，
 * 兜底 `agent`（防空串/路径穿越/保留字）。
 *
 * 独立工具文件（不从 tasks.service 导出）：worker-dispatcher 与 tasks.service 共用同一
 * 规则，但 worker-dispatcher → tasks.service 会与 task-progression.scheduler →
 * worker-dispatcher 形成循环依赖（CJS 下 decorator 元数据拿到 undefined token，Nest
 * 无法解析构造依赖）。抽离为无依赖纯函数模块打破循环。
 */
export function sanitizeWorkDirName(name: string): string {
  const raw = String(name ?? '').trim();
  const base =
    raw
      .replace(/[^\p{L}\p{N}._-]/gu, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .replace(/\.{2,}/g, '.') || 'agent';
  return base;
}
