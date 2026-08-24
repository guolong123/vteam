/**
 * 计划质量预检：planSubmit 服务端结构预检，在人工/成员评审前打回不可执行的计划。
 *
 * 契约：errors 非空 → 调用方必须拒绝提交（信息面向提交方书写，含字段定位与改法示例）；
 * warnings 不阻断，随提交结果透出供评审者重点核查。
 */

/** qa 可执行性判定用的工具/动作特征词表（小写匹配）。覆盖 vteam agent 常用验证手段。 */
const QA_TOOL_TOKENS = [
  // 浏览器/UI 自动化
  'playwright',
  'puppeteer',
  'selenium',
  '截图',
  '点击',
  '输入',
  '打开页面',
  '断言',
  // HTTP/API
  'curl',
  'wget',
  'http',
  'https://',
  'postman',
  'apifox',
  'swagger',
  '请求',
  '响应',
  // 测试框架/命令
  'jest',
  'vitest',
  'mocha',
  'pytest',
  'unittest',
  'go test',
  'cargo test',
  'mvn ',
  'gradle',
  'npm ',
  'npx ',
  'pnpm ',
  'yarn ',
  'bun ',
  'node ',
  'python ',
  'java ',
  // 数据库
  'sql',
  'select ',
  'insert ',
  'update ',
  'mysql',
  'redis',
  // git/文件
  'git ',
  'git-',
  'diff',
  'grep',
  'ls ',
  'cat ',
] as const;

/**
 * 结构特征兜底：qa 未命中词表时，若含命令行/路径/参数形态也算可执行
 * （如 "opencode --version 输出版本号"、"/api/v1/users 返回 200"、"npm run build 无报错"）。
 */
const QA_STRUCTURE_PATTERNS = [
  /\/[a-z0-9_-][a-z0-9_\-/.]*/i, // 路径形态（URL path / 文件路径）
  /(^|\s)--?[a-z][\w-]*(\s|$|=)/i, // CLI flag 形态
  /\d{3}\b/, // HTTP 状态码
  /\b(expect|assert|should|toEqual|toBe|toContain)\b/i, // 断言关键词
  /[a-z]+_[a-z]+/i, // snake_case（MCP 工具名/函数名特征）
] as const;

/** 纯空话模式：整段只有「测试/验证/确认/检查」类动词及其修饰，无任何实质内容。 */
const QA_EMPTY_TALK_PATTERN =
  /^(仅|再|先|重新|认真|仔细|严格)?(进行|做|跑)?(一下)?(测试|验证|确认|检查|自测|回归)[一下的吗。.！!？?\s]*$/;

/** acceptance 纯结论词：整段只有这些词的组合视为不可判定。 */
const ACCEPTANCE_EMPTY_PATTERN = /^[\s正常可用完成okokay通过没问题,，。.!！的]+$/i;

export interface PlanQualityInput {
  title: string;
  what: string;
  mustNot?: string;
  references?: string;
  acceptance: string;
  qa: string;
}

export interface PlanQualityResult {
  /** 硬门槛错误（每条含子任务定位 + 改法指导）；非空则应拒绝提交。 */
  errors: string[];
  /** 软警告（不阻断）；随提交结果透出供评审关注。 */
  warnings: string[];
}

function hasQaToolToken(qa: string): boolean {
  const lower = qa.toLowerCase();
  return QA_TOOL_TOKENS.some((token) => lower.includes(token));
}

function hasQaStructureSignal(qa: string): boolean {
  return QA_STRUCTURE_PATTERNS.some((pattern) => pattern.test(qa));
}

/**
 * 对单条计划子任务执行质量预检。纯函数、零 IO——错误信息直接面向
 * 提交方（主 Agent）书写：指明字段、说明缺陷、给出正确示例。
 */
export function validatePlanTaskQuality(task: PlanQualityInput): PlanQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const at = (field: string, problem: string, fix: string) =>
    `子任务「${task.title}」${field}：${problem}。${fix}`;

  // ---- qa 可执行性（硬门槛）----
  const qa = task.qa.trim();
  if (qa.length < 8) {
    errors.push(
      at('qa', `内容过短（${qa.length} 字符），无法作为机器可执行的验证依据`, '请按「工具＋步骤＋预期结果」重写，如 "curl POST /api/v1/users 缺少 name 字段，断言返回 400"'),
    );
  } else if (QA_EMPTY_TALK_PATTERN.test(qa)) {
    errors.push(
      at('qa', '属于纯空话表述（只有测试/验证类动词，没有工具与步骤）', '请写明用什么工具、执行什么步骤、期望什么结果，如 "playwright 打开 /login 输入错误密码提交，断言出现『密码错误』提示"'),
    );
  } else if (!hasQaToolToken(qa) && !hasQaStructureSignal(qa)) {
    errors.push(
      at('qa', '未包含任何可执行工具或结构化步骤（无工具词/路径/命令/断言特征）', '请补充具体验证手段，如 playwright/curl/jest/git diff/接口路径/CLI 命令等'),
    );
  }

  // ---- acceptance 可判定性（硬门槛）----
  const acceptance = task.acceptance.trim();
  if (acceptance.length < 6) {
    errors.push(
      at('acceptance', `内容过短（${acceptance.length} 字符），不可判定`, '请写明可判定的通过条件，如 "访问 /login 提交错误密码返回 401 且提示文案包含『密码错误』"'),
    );
  } else if (ACCEPTANCE_EMPTY_PATTERN.test(acceptance)) {
    errors.push(
      at('acceptance', '属于纯结论词（"正常/可用/完成"），无法判定通过与不通过的边界', '请改为可观测的具体行为或指标，如 "构建日志出现 build finished 且退出码为 0"'),
    );
  }

  // ---- references 引用形态（软警告）----
  const references = (task.references ?? '').trim();
  if (references.length > 0 && !/[/.]/.test(references)) {
    warnings.push(
      `子任务「${task.title}」references 未含任何路径/文件引用（"${references.slice(0, 40)}"），评审将无法核查引用真实性，建议补充具体文件路径或来源`,
    );
  }

  return { errors, warnings };
}
