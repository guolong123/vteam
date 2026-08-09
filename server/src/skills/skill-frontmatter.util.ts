import { BadRequestException } from '@nestjs/common';
import { SKILL_ERRORS } from '../common/constants/skill.constants';

/**
 * SKILL.md frontmatter 解析与校验（T1，09 篇 §3.8 multipart 上传）。
 *
 * 轻量手写 YAML 子集解析：字段少（name/description/version/allowed-tools）免依赖，
 * 覆盖 SKILL.md 实际使用的三种写法：
 *   - 标量：`key: value`（含 `"quoted"` / `'quoted'`）
 *   - 块标量：`key: |` / `key: >`（缩进多行续写）
 *   - 列表：`key:` 后跟缩进 `- item` 行，或内联流式 `[a, b]`
 */

/** skill name 命名规范（11 篇 §4.1：小写字母数字 + 中划线分段）。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 技能 name 长度上限（对齐 skills.name VARCHAR(191) 与原 DTO MaxLength(64) 取小）。 */
export const SKILL_NAME_MAX_LENGTH = 64;

/** multipart 上传的 SKILL.md 文件（multer 内存存储，buffer 为全文）。 */
export interface UploadedSkillFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** frontmatter 解析结果（键名对齐 SKILL.md 约定）。 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  'allowed-tools'?: string[];
}

/** 解析结果：frontmatter 元数据 + SKILL.md 全文（content 落库原文）。 */
export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  content: string;
}

/** 400：SKILL_FRONTMATTER_INVALID（消息带具体原因）。 */
function throwInvalid(reason: string): never {
  throw new BadRequestException({
    code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID,
    message: `SKILL.md frontmatter 非法：${reason}`,
  });
}

/** 去除 YAML 标量值首尾引号。 */
function stripQuotes(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

/** 解析一行 YAML 键值（首个冒号分割，兼容 description 含中文冒号）。 */
function splitKeyValue(trimmed: string): [string, string] | null {
  const colon = trimmed.indexOf(':');
  if (colon === -1) return null;
  return [trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()];
}

/**
 * 解析 SKILL.md：必须为 `---` 开头的 YAML frontmatter 块。
 * - 首行非 `---` → 400（非技能包）
 * - 无结束 `---` → 400（frontmatter 未闭合）
 * - 返回 {frontmatter, content}，content 为原始全文（含 frontmatter，worker 注入需原文）
 */
export function parseSkillMarkdown(raw: string): ParsedSkillFile {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throwInvalid('文件必须以 --- 开头的 YAML frontmatter 声明元数据');
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throwInvalid('未找到 frontmatter 结束标记 ---');
  }

  const frontmatter = parseYamlSimple(lines.slice(1, end));
  return { frontmatter, content: raw };
}

/** 逐行解析 frontmatter YAML 子集（标量/块标量/列表）。内部用宽松索引类型规避键联合类型。 */
function parseYamlSimple(lines: string[]): SkillFrontmatter {
  const fm: Record<string, string | string[]> = {};
  let key: string | null = null;
  let mode: 'scalar' | 'list' | null = null;

  const flushBlock = () => {
    if (key && mode === 'scalar' && typeof fm[key] === 'string') {
      fm[key] = (fm[key] as string).replace(/\n+$/, '').trim();
    }
    key = null;
    mode = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent > 0 && key && mode) {
      // 缩进续行：块标量内容 / 列表项
      if (mode === 'list' && trimmed.startsWith('- ')) {
        const arr = (fm[key] as string[] | undefined) ?? [];
        arr.push(stripQuotes(trimmed.slice(2).trim()));
        fm[key] = arr;
      } else if (mode === 'scalar') {
        fm[key] = (fm[key] as string) + trimmed + '\n';
      }
      continue;
    }

    flushBlock();
    const kv = splitKeyValue(trimmed);
    if (!kv) continue; // 非键值行忽略
    const [k, v] = kv;
    if (k !== 'name' && k !== 'description' && k !== 'version' && k !== 'allowed-tools') {
      continue; // 未知字段忽略（保持宽松，SKILL.md 可含其他元数据）
    }
    if (v === '|' || v === '>') {
      key = k;
      mode = 'scalar';
      fm[k] = '';
    } else if (v === '') {
      key = k;
      mode = 'list';
      fm[k] = [];
    } else if (v.startsWith('[') && v.endsWith(']')) {
      fm[k] = v
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
    } else {
      fm[k] = stripQuotes(v);
    }
  }
  flushBlock();
  return fm as SkillFrontmatter;
}

/**
 * 重写 SKILL.md frontmatter 中单个字段（UX-15 PATCH /skills/:id 编辑元信息时同步，
 * 维持「DB name/description 列 = content frontmatter」不变量——worker 注入用 content 原文，
 * 若列与 frontmatter 脱钩会导致注入的 SKILL.md 名与列表展示名不一致）。
 *
 * 覆盖三种写法（与 parseYamlSimple 对称）：
 * - 标量：`key: value`（含 `"quoted"`，替换整行）
 * - 块标量：`key: |` / `key: >`（value 为 null 时连续行整块删除）
 * - 缺省：frontmatter 内无该字段 → 在结束 `---` 前追加 `key: value`
 *
 * value 为 null/空串表示删除该字段；raw 非合法 SKILL.md（无 `---` 块）时原样返回
 * （PATCH content 校验已保证其合法，此处兜底不抛错）。
 */
export function rewriteFrontmatterField(
  raw: string,
  key: 'name' | 'description',
  value: string | null,
): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return raw;

  // 找到 key 起始行（target=-1 表示 frontmatter 内缺省）
  let target = -1;
  for (let i = 1; i < end; i++) {
    if (lines[i].trimStart().startsWith(`${key}:`)) {
      target = i;
      break;
    }
  }

  const isEmpty = value === null || value.trim() === '';

  // 删除：连块标量续行（后续以空格/制表符缩进的行）整块移除
  if (isEmpty) {
    if (target === -1) return raw;
    let last = target;
    let j = target + 1;
    while (j < end && /^[ \t]/.test(lines[j])) {
      last = j;
      j++;
    }
    return [...lines.slice(0, target), ...lines.slice(last + 1)].join('\n');
  }

  const line = `${key}: ${value}`;
  if (target === -1) {
    // 追加到 frontmatter 块末尾（结束 --- 之前）
    return [...lines.slice(0, end), line, ...lines.slice(end)].join('\n');
  }
  let last = target;
  let j = target + 1;
  while (j < end && /^[ \t]/.test(lines[j])) {
    last = j;
    j++;
  }
  return [...lines.slice(0, target), line, ...lines.slice(last + 1)].join('\n');
}

/** frontmatter name 字段校验：必填 + 命名规范 + 长度上限。非法 → 400 SKILL_FRONTMATTER_INVALID。 */
export function assertSkillName(frontmatter: SkillFrontmatter): string {
  const name = frontmatter.name?.trim() ?? '';
  if (!name) {
    throwInvalid('缺少必填字段 name');
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throwInvalid(
      `name「${name}」不符合命名规范（小写字母数字，中划线分段，如 git-ops）`,
    );
  }
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    throwInvalid(`name 超过 ${SKILL_NAME_MAX_LENGTH} 字符上限`);
  }
  return name;
}
