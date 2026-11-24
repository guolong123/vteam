#!/usr/bin/env python3
"""把 src 下因复合唯一键改造而编译失败的 where 包裹成 tenantUniqueWhere(...)。

输入：tsc 错误列表（从 stdin 读 `file(line,col): error TS...`）。
策略：对每个错误位置，向上找最近的 prisma delegate 调用，取模型名；
在调用内找到第一个 `where: {`，改成 `where: tenantUniqueWhere('Model', {`，
并在对应对象闭合括号后补 `)`；最后补 import。
"""
import re
import sys
from pathlib import Path

ROOT = Path('src')
IMPORT_REL = 'common/tenant/tenant-unique'

err_re = re.compile(r'^(src/[^(]+)\((\d+),\d+\): error TS\d+')
errors = {}
for line in sys.stdin:
    m = err_re.match(line.strip())
    if not m:
        continue
    f, ln = m.group(1), int(m.group(2))
    errors.setdefault(f, set()).add(ln)

CALL_RE = re.compile(
    r'prisma\.(\w+)\.(findUnique|findUniqueOrThrow|update|delete|upsert)\s*\('
)

def pascal(name: str) -> str:
    return name[0].upper() + name[1:]

def find_call(lines, idx):
    """向上找最近的 prisma 唯一操作调用，返回 (call_line_idx, delegate, model)。"""
    for i in range(idx, max(-1, idx - 25), -1):
        m = CALL_RE.search(lines[i])
        if m:
            return i, m.group(1), pascal(m.group(1))
    return None

def match_brace(text, open_idx):
    """text[open_idx] == '{'，返回匹配的 '}' 下标（跳过字符串内部）。"""
    depth = 0
    i = open_idx
    in_str = None
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError('unbalanced braces')

changed = {}
for f, lns in errors.items():
    path = Path(f)
    text = path.read_text(encoding='utf-8')
    lines = text.split('\n')
    # 处理顺序从后往前，避免行号偏移
    for ln in sorted(lns, reverse=True):
        idx = ln - 1
        call = find_call(lines, idx)
        if not call:
            print(f'WARN 找不到调用: {f}:{ln}')
            continue
        call_i, delegate, model = call
        # 在调用起始行之后找 where: {
        joined_start = '\n'.join(lines[call_i:])
        wm = re.search(r'where:\s*\{', joined_start)
        if not wm:
            print(f'WARN 找不到 where: {f}:{ln}')
            continue
        where_open = wm.end() - 1
        # 转成全文坐标
        prefix_len = sum(len(x) + 1 for x in lines[:call_i])
        abs_open = prefix_len + where_open
        abs_close = match_brace(text, abs_open)
        # 若已经包裹过则跳过
        if 'tenantUniqueWhere(' in text[max(0, abs_open - 40):abs_open]:
            continue
        insert = f"tenantUniqueWhere('{model}', "
        text = text[:abs_open] + insert + text[abs_open:abs_close + 1] + ')' + text[abs_close + 1:]
    # 补 import（放在最后一个 import 之后）
    if 'tenantUniqueWhere' not in text.split('describe(')[0]:
        rel = Path(IMPORT_REL)
        depth = len(Path(f).parent.parts) - 1  # relative to src
        rel_import = ('./' if depth == 0 else '../' * depth) + IMPORT_REL
        lines = text.split('\n')
        last_import = max(i for i, l in enumerate(lines) if l.startswith('import '))
        lines.insert(last_import + 1, f"import {{ tenantUniqueWhere }} from '{rel_import}';")
        text = '\n'.join(lines)
    path.write_text(text, encoding='utf-8')
    changed[f] = len(lns)
    print(f'patched {f}: {len(lns)} 处')

print(f'共 {len(changed)} 个文件')
