/**
 * 字段模板渲染工具（generic/github/gitee 共用）。
 * 模板内 {{ path }} 按 data 对象路径提取，缺失返回空串。
 * 支持：
 * - 点号路径 a.b.c
 * - 括号索引 a[0].b / commits[0].message / a.b[0].c
 * - 多级括号 a[0][1]
 * per-event fieldMappings 依赖此工具将 payload 不同事件的字段映射为统一 InboundCommand。
 */
function get(data: any, path: string): any {
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

export function renderFieldTemplate(template: string, data: any): string {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => {
    const v = get(data, (path as string).trim());
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return String(v);
    } catch {
      return '';
    }
  });
}
