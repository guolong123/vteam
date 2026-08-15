/**
 * 平台内置 git 工具族定义与注入机制（T5，17 篇 §4）。
 *
 * 工具清单对齐 17 篇 §4.1（git_clone/git_pull/git_fetch/git_status/git_diff/git_log/git_push）；
 * 注入落点：worker 实例侧 .opencode/tools/git.ts（17 篇 §4.2 路径①：目录扫描自动注册）。
 * 单文件具名导出，工具名 = <文件名>_<导出名>（git.ts 导出 clone → git_clone），
 * 工具名即权限 action。
 *
 * todo 4（凭证注入升级）：renderGitToolsFile 生成的 git.ts 为自包含文件（不 import worker 源码，
 * 由 opencode serve 独立执行）。clone/pull/fetch/push 执行时读取平台下发的凭证白名单
 * （~/.keta-git-creds.json，todo 3 落盘契约），SSH 走 GIT_SSH_COMMAND 临时 key / HTTPS 走
 * GIT_ASKPASS 临时脚本，try/finally 清理；push 额外校验 write 授权；status/diff/log 为本地
 * 只读工具不加载凭证。辅助函数以 toString() 内联进渲染产物——本文件的实现即渲染产物的实现。
 */

import * as crypto from 'crypto';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 注入目标目录（相对 opencode serve 工作目录，17 篇 §4.2）。 */
export const GIT_TOOLS_REL_DIR = path.join('.opencode', 'tools');

/** 工具文件名（17 篇 §4.2 单文件具名导出形态）。 */
export const GIT_TOOL_FILE = 'git.ts';

/** 平台 git 凭证落盘路径（todo 3 契约；渲染产物内联同名常量）。 */
export const GIT_CREDS_FILE = path.join(os.homedir(), '.keta-git-creds.json');

/** 工具默认 effect（07 篇 §3.1：有副作用工具默认 ask）。 */
export type GitToolEffect = 'allow' | 'ask';

/** 工具参数定义（inputSchema 的声明式描述，渲染为 opencode tool.schema）。 */
export interface GitToolArg {
  /** 参数名（与 17 篇 §4.1 关键参数列一致）。 */
  name: string;
  /** schema 类型（渲染为 tool.schema.string()/boolean()/number()）。 */
  type: 'string' | 'boolean' | 'integer';
  /** 是否必填（必填不带 .optional()）。 */
  required: boolean;
  /** 参数描述。 */
  description: string;
}

/** 单个 git 工具定义。 */
export interface GitToolDef {
  /** 完整工具名 = <文件名>_<导出名>（如 git_clone），即权限 action。 */
  name: string;
  /** 导出标识（工具名规则中的 <导出名> 部分）。 */
  exportName: string;
  /** 工具描述。 */
  description: string;
  /** 默认 effect（permission 规则默认值）。 */
  defaultEffect: GitToolEffect;
  /** 参数定义（inputSchema）。 */
  args: GitToolArg[];
  /** execute 行为说明（渲染为生成文件内最小实现的引导注释）。 */
  executeHint: string;
}

/** 平台下发凭证条目（todo 3 落盘契约，permission 由 server 授权打包写入）。 */
export interface GitCredentialEntry {
  /** 仓库地址（可能带 .git 后缀，匹配时经 normalizeRepoUrl 规范化）。 */
  repoUrl: string;
  /** 认证方式：ssh_key | https_token。 */
  authType: 'ssh_key' | 'https_token' | string;
  /** SSH 私钥 / HTTPS token 明文（仅本工具 execute 内存使用，不落日志/响应）。 */
  key: string;
  /** 指纹（脱敏展示用，可缺省）。 */
  fingerprint?: string;
  /** 授权权限 read | write（push 需 write）。 */
  permission?: string;
}

/**
 * 规范化仓库 URL（trim + 去尾部 .git + 协议前缀小写），供白名单匹配。
 * 内联进渲染产物（todo 4）：generated git.ts 与实现同源。
 */
export function normalizeRepoUrl(u: string): string {
  return String(u || '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^https:\/\//i, 'https://')
    .replace(/^ssh:\/\//i, 'ssh://');
}

/**
 * 读凭证白名单并匹配仓库（todo 4 白名单校验）。
 * 文件缺失/损坏 → 抛「仓库凭证文件不存在或损坏」；未命中 → 抛「仓库未授权或凭证缺失: <url>」，
 * 错误信息不含明文 key。
 */
export function loadCredential(repoUrl: string): GitCredentialEntry {
  // 自包含：不引用模块级 GIT_CREDS_FILE 常量（TS 编译产物 toString() 内联进 ES module
  // git.ts 后，CommonJS 模块作用域变量不可见），此处函数内局部求值保证渲染产物可独立执行。
  const credsFile = path.join(os.homedir(), '.keta-git-creds.json');
  let parsed: { credentials?: GitCredentialEntry[] };
  try {
    parsed = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
  } catch {
    throw new Error('仓库凭证文件不存在或损坏');
  }
  const creds = parsed?.credentials ?? [];
  const normalized = normalizeRepoUrl(repoUrl);
  const entry = creds.find((c) => normalizeRepoUrl(c.repoUrl) === normalized);
  if (!entry) {
    throw new Error(`仓库未授权或凭证缺失: ${normalized}`);
  }
  return entry;
}

/**
 * SSH 私钥格式归一（OPENSSH 容器格式 ssh-rsa → PKCS#1 PEM）。
 *
 * 背景：部分 OPENSSH 容器格式的 ssh-rsa 私钥在 OpenSSL 3.x（worker 容器
 * OpenSSH 10.3/OpenSSL 3.5，宿主机 8.9/3.0 均复现）加载报
 * `error in libcrypto: unsupported`，`ssh -i` 静默跳过该 identity → git_clone 失败。
 * 密钥数学有效，纯容器格式兼容问题（详见 .omo/evidence/role-instance-separation/git-ssh-key-format.txt）。
 *
 * 行为（仅 worker 侧兜底，不改 server/凭证存储）：
 * - key 不含 `-----BEGIN OPENSSH PRIVATE KEY-----` 头（PEM/其他格式）→ 原样返回；
 * - 解 openssh-key-v1 容器（cipher/kdf 须为 none 即未加密），读私钥块 keytype：
 *   - `ssh-rsa` → 提取 n/e/d/p/q → 计算 dp/dq/qinv → 构 PKCS#1 RSAPrivateKey DER
 *     → `-----BEGIN RSA PRIVATE KEY-----` PEM（64 字符换行）；
 *   - 其他（ssh-ed25519 等）→ 原样返回（不受该问题影响，转 PKCS#1 反而破坏）；
 * - 加密（ciphername != none）→ 抛错，不静默降级；容器/私钥块结构非法 → 抛错。
 *
 * 自包含：不引用模块级变量，可被 renderGitToolsFile toString() 内联进渲染产物
 * git.ts（同 loadCredential 约定）；纯 Node 实现，不依赖 openssl 二进制 /
 * ssh-keygen -p（后者在 worker 容器内对问题 key 也失败）。
 */
export function normalizeSshKey(key: string): string {
  // ---- mpint/ASN.1 纯 Node 内联辅助（无模块级依赖，随本函数 toString 内联） ----
  // RFC 4251 mpint → BigInt：正数剥离前导 0x00（含符号位填充）；负数不支持（RSA 参数恒正）。
  const mpintToBigInt = (raw: Buffer): bigint => {
    if (raw.length === 0) {
      return 0n;
    }
    if ((raw[0] & 0x80) !== 0) {
      throw new Error('cannot parse openssh private key: negative mpint not supported');
    }
    let start = 0;
    while (start < raw.length - 1 && raw[start] === 0x00) {
      start += 1;
    }
    if (raw[start] === 0x00) {
      return 0n;
    }
    return BigInt('0x' + raw.subarray(start).toString('hex'));
  };
  // DER 长度编码（BER definite，short/long 形式）。
  const derLen = (n: number): Buffer => {
    if (n < 0x80) {
      return Buffer.from([n]);
    }
    const bytes: number[] = [];
    let v = n;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v = v >>> 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  // DER INTEGER：非负；最高位 bit7=1 时前导 0x00 符号位；0 编码为单字节 0x00。
  const derInt = (v: bigint): Buffer => {
    if (v < 0n) {
      throw new Error('cannot build pkcs1 private key: negative integer not supported');
    }
    const bytes: number[] = [];
    let t = v;
    while (t > 0n) {
      bytes.unshift(Number(t & 0xffn));
      t >>= 8n;
    }
    if (bytes.length === 0) {
      bytes.push(0);
    }
    if ((bytes[0] & 0x80) !== 0) {
      bytes.unshift(0);
    }
    return Buffer.concat([Buffer.from([0x02]), derLen(bytes.length), Buffer.from(bytes)]);
  };
  // DER SEQUENCE。
  const derSeq = (parts: Buffer[]): Buffer => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
  };
  // 模逆（扩展欧几里得，BigInt）。
  const modInverse = (a: bigint, m: bigint): bigint => {
    let oldR = ((a % m) + m) % m;
    let r = m;
    let oldS = 1n;
    let s = 0n;
    while (r !== 0n) {
      const q = oldR / r;
      [oldR, r] = [r, oldR - q * r];
      [oldS, s] = [s, oldS - q * s];
    }
    if (oldR !== 1n) {
      throw new Error('cannot build pkcs1 private key: no modular inverse for q mod p');
    }
    return ((oldS % m) + m) % m;
  };
  // ---- 容器解析 ----
  const src = String(key);
  if (!src.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    return key;
  }
  const b64 = src
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/g, '')
    .replace(/-----END OPENSSH PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) {
    throw new Error('cannot parse openssh private key: empty body');
  }
  const MAGIC = Buffer.from('openssh-key-v1\0', 'utf8');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('cannot parse openssh private key: bad magic');
  }
  let off = MAGIC.length;
  const need = (n: number): void => {
    if (off + n > buf.length) {
      throw new Error('cannot parse openssh private key: truncated container');
    }
  };
  const readU32 = (): number => {
    need(4);
    const v = buf.readUInt32BE(off);
    off += 4;
    return v;
  };
  const readStr = (): Buffer => {
    const len = readU32();
    need(len);
    const out = buf.subarray(off, off + len);
    off += len;
    return out;
  };
  const ciphername = readStr().toString('utf8');
  const kdfname = readStr().toString('utf8');
  readStr(); // kdfoptions（cipher=none 时为空串）
  const nkeys = readU32();
  if (ciphername !== 'none' || kdfname !== 'none') {
    throw new Error('encrypted openssh private key is not supported');
  }
  if (nkeys !== 1) {
    throw new Error(`cannot parse openssh private key: unsupported nkeys=${nkeys}`);
  }
  readStr(); // public key blob（nkeys=1，跳过）
  const privBlock = readStr();
  // 私钥块：checkint×2, keytype, keyfields..., comment, padding
  let po = 0;
  const pNeed = (n: number): void => {
    if (po + n > privBlock.length) {
      throw new Error('cannot parse openssh private key: truncated private block');
    }
  };
  const pReadU32 = (): number => {
    pNeed(4);
    const v = privBlock.readUInt32BE(po);
    po += 4;
    return v;
  };
  const pReadStr = (): Buffer => {
    const len = pReadU32();
    pNeed(len);
    const out = privBlock.subarray(po, po + len);
    po += len;
    return out;
  };
  const check1 = pReadU32();
  const check2 = pReadU32();
  if (check1 !== check2) {
    throw new Error('cannot parse openssh private key: checkint mismatch');
  }
  const keytype = pReadStr().toString('utf8');
  if (keytype !== 'ssh-rsa') {
    return key; // ssh-ed25519 等不受该问题影响，原样返回
  }
  // ssh-rsa 私钥字段顺序（OpenSSH PROTOCOL.key）：n, e, d, iqmp, p, q
  const n = mpintToBigInt(pReadStr());
  const e = mpintToBigInt(pReadStr());
  const d = mpintToBigInt(pReadStr());
  pReadStr(); // iqmp = q^{-1} mod p（PKCS#1 需重新计算，直接跳过）
  const p = mpintToBigInt(pReadStr());
  const q = mpintToBigInt(pReadStr());
  // 私钥块尾部 comment + padding 无需读取（pReadStr 已校验不越界）。

  // ---- 构 PKCS#1 RSAPrivateKey DER（version=0; n,e,d; p,q; dp,dq; qinv） ----
  const der = derSeq([
    derInt(0n), // version
    derInt(n),
    derInt(e),
    derInt(d),
    derInt(p),
    derInt(q),
    derInt(d % (p - 1n)), // exponent1 = d mod (p-1)
    derInt(d % (q - 1n)), // exponent2 = d mod (q-1)
    derInt(modInverse(q, p)), // coefficient = q^{-1} mod p
  ]);
  const wrapped = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '');
  return `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----\n`;
}

/** 写临时 SSH 私钥文件（随机路径 + 0o600），返回路径；调用方 finally cleanupTemp。 */
export function writeTempKey(key: string): string {
  // ssh_key 落盘前格式归一：OPENSSH 容器格式 ssh-rsa → PKCS#1 PEM（兼容 OpenSSL 3.x，
  // 见 normalizeSshKey）。转换失败抛错（buildGitEnv/runGit 调用方错误链路已处理，不静默降级）。
  const normalized = normalizeSshKey(key);
  const keyPath = path.join(os.tmpdir(), `keta-git-key-${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(keyPath, normalized, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return keyPath;
}

/**
 * 写临时 GIT_ASKPASS 脚本（随机路径 + 0o600 + chmod 0o755）。
 * token 单引号转义：`'` → `'\''`（防单引号破坏 shell 脚本/注入）。
 */
export function writeAskpass(token: string): string {
  const scriptPath = path.join(os.tmpdir(), `keta-git-askpass-${crypto.randomBytes(8).toString('hex')}`);
  const escaped = String(token).replace(/'/g, "'\\''");
  fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${escaped}'\n`, { mode: 0o600 });
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** 删除临时文件（幂等：不存在静默忽略）。 */
export function cleanupTemp(p: string): void {
  fs.rmSync(p, { force: true });
}

/**
 * 按凭证 authType 构造 git 子进程注入 env + 需清理的临时文件路径。
 * ssh_key → GIT_SSH_COMMAND 指定临时 key；https_token → GIT_ASKPASS 临时脚本。
 */
export function buildGitEnv(entry: GitCredentialEntry): { env: Record<string, string>; paths: string[] } {
  if (entry.authType === 'ssh_key') {
    const keyPath = writeTempKey(entry.key);
    return {
      env: { GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no` },
      paths: [keyPath],
    };
  }
  const scriptPath = writeAskpass(entry.key);
  return {
    env: { GIT_ASKPASS: scriptPath, GIT_TERMINAL_PROMPT: '0' },
    paths: [scriptPath],
  };
}

/** spawn git（合并注入 env），非 0 退出抛错（stderr/stdout，不含 token 明文）。 */
export function runGit(gitArgs: string[], env: Record<string, string> = {}): string {
  const result = child_process.spawnSync('git', gitArgs, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${gitArgs.join(' ')} failed (exit ${result.status}): ${err}`);
  }
  return result.stdout ?? '';
}

/** 取当前 cwd 的 remote.origin.url（pull/fetch/push 缺省 repo_url 时），非 git 仓库返回 null。 */
export function cwdOrigin(): string | null {
  const result = child_process.spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  const url = (result.stdout ?? '').trim();
  return url || null;
}

/**
 * 工具 exportName → git 参数数组（渲染产物内联 _buildGitArgs）。
 * 本模块实现与渲染产物同源（toString 注入）。
 */
export function _buildGitArgs(exportName: string, args: Record<string, unknown>): string[] {
  const a: string[] = [];
  switch (exportName) {
    case 'clone':
      a.push('clone');
      if (args.ref) a.push('--branch', String(args.ref));
      a.push(String(args.repo_url));
      if (args.target) a.push(String(args.target));
      break;
    case 'pull':
      a.push('pull');
      if (args.repo_url) a.push(String(args.repo_url));
      break;
    case 'fetch':
      a.push('fetch');
      if (args.repo_url) a.push(String(args.repo_url));
      if (args.ref) a.push(String(args.ref));
      break;
    case 'status':
      a.push('status');
      if (args.porcelain) a.push('--porcelain');
      break;
    case 'diff':
      a.push('diff');
      if (args.ref_a) a.push(String(args.ref_a));
      if (args.ref_b) a.push(String(args.ref_b));
      if (args.path) a.push('--', String(args.path));
      break;
    case 'log':
      a.push('log');
      if (args.limit) a.push('-n', String(args.limit));
      if (args.path) a.push('--', String(args.path));
      break;
    case 'push':
      a.push('push');
      if (args.repo_url) a.push(String(args.repo_url));
      a.push(String(args.refspec));
      break;
    default:
      throw new Error(`unknown git tool export: ${exportName}`);
  }
  return a;
}

/**
 * git 工具族清单（17 篇 §4.1 七工具）。
 * 写操作仅 git_push 默认 ask（写远端核心副作用），其余写本地/只读默认 allow。
 * 远端工具（clone/pull/fetch/push）依赖平台仓库授权（todo 4），push 额外需 write 授权。
 */
export const GIT_TOOLS: readonly GitToolDef[] = [
  {
    name: 'git_clone',
    exportName: 'clone',
    description: '克隆仓库到工作目录（需平台仓库授权）',
    defaultEffect: 'allow',
    args: [
      { name: 'repo_url', type: 'string', required: true, description: '仓库地址，如 git@gitee.com:xishuhq/ketaops.git' },
      { name: 'ref', type: 'string', required: false, description: '分支/标签，缺省取远端默认分支' },
      { name: 'target', type: 'string', required: false, description: '目标目录，缺省取仓库名' },
    ],
    executeHint: 'git clone [--branch ref] repo_url [target]',
  },
  {
    name: 'git_pull',
    exportName: 'pull',
    description: '拉取远端更新到当前工作区（需平台仓库授权）',
    defaultEffect: 'allow',
    args: [
      { name: 'repo_url', type: 'string', required: false, description: '仓库地址，缺省取当前目录 origin' },
    ],
    executeHint: 'git pull [repo_url]',
  },
  {
    name: 'git_fetch',
    exportName: 'fetch',
    description: '获取远端引用（不合并，需平台仓库授权）',
    defaultEffect: 'allow',
    args: [
      { name: 'repo_url', type: 'string', required: false, description: '仓库地址，缺省取当前目录 origin' },
      { name: 'ref', type: 'string', required: false, description: '远端引用/分支' },
    ],
    executeHint: 'git fetch [repo_url] [ref]',
  },
  {
    name: 'git_status',
    exportName: 'status',
    description: '查看工作区/暂存区状态',
    defaultEffect: 'allow',
    args: [
      { name: 'porcelain', type: 'boolean', required: false, description: '以 --porcelain 机器可读格式输出' },
    ],
    executeHint: 'git status [--porcelain]',
  },
  {
    name: 'git_diff',
    exportName: 'diff',
    description: '查看工作区/提交间差异',
    defaultEffect: 'allow',
    args: [
      { name: 'ref_a', type: 'string', required: false, description: '对比基线提交/引用' },
      { name: 'ref_b', type: 'string', required: false, description: '对比目标提交/引用' },
      { name: 'path', type: 'string', required: false, description: '限定路径（传入 -- path）' },
    ],
    executeHint: 'git diff [ref_a] [ref_b] [-- path]',
  },
  {
    name: 'git_log',
    exportName: 'log',
    description: '查看提交历史',
    defaultEffect: 'allow',
    args: [
      { name: 'limit', type: 'integer', required: false, description: '限制条数（-n）' },
      { name: 'path', type: 'string', required: false, description: '限定路径（传入 -- path）' },
    ],
    executeHint: 'git log [-n limit] [-- path]',
  },
  {
    name: 'git_push',
    exportName: 'push',
    description: '推送本地提交到远端（需平台 write 授权，默认 ask 确认流）',
    defaultEffect: 'ask',
    args: [
      { name: 'repo_url', type: 'string', required: false, description: '仓库地址，缺省取当前目录 origin' },
      { name: 'refspec', type: 'string', required: true, description: '推送引用规格，如 main:main' },
    ],
    executeHint: 'git push [repo_url] refspec',
  },
];

/** 需平台凭证的远端工具（todo 4 工具级权限矩阵：其余 status/diff/log 本地只读不加载凭证）。 */
const REMOTE_EXPORT_NAMES = ['clone', 'pull', 'fetch', 'push'] as const;

/**
 * 渲染 .opencode/tools/git.ts 文件内容（opencode 自定义工具具名导出格式）。
 * 导出名 → 工具名 <文件名>_<导出名>；生成的 git.ts 自包含：凭证辅助函数经 toString()
 * 内联（本文件实现 = 渲染产物实现），不 import worker 源码。
 */
export function renderGitToolsFile(defs: readonly GitToolDef[] = GIT_TOOLS): string {
  const renderArgSchema = (arg: GitToolArg): string => {
    const schemaType = arg.type === 'integer' ? 'number' : arg.type;
    const base = `tool.schema.${schemaType}()`;
    const schema = arg.required ? base : `${base}.optional()`;
    return `${schema}.describe(${JSON.stringify(arg.description)})`;
  };

  const renderTool = (def: GitToolDef): string => {
    const argLines = def.args
      .map((arg) => `    ${arg.name}: ${renderArgSchema(arg)},`)
      .join('\n');

    const isRemote = (REMOTE_EXPORT_NAMES as readonly string[]).includes(def.exportName);
    let executeLines: string[];
    if (isRemote) {
      const repoUrlLine =
        def.exportName === 'clone'
          ? 'const repoUrl = String(args.repo_url);'
          : 'const repoUrl = args.repo_url ? String(args.repo_url) : cwdOrigin();';
      const pushGuard =
        def.exportName === 'push'
          ? ['if (entry.permission !== "write") {', '  throw new Error(`仓库 ${repoUrl} 未授予 write 权限，禁止 push`);', '}']
          : [];
      executeLines = [
        repoUrlLine,
        'const entry = loadCredential(repoUrl);',
        ...pushGuard,
        'const tmp = buildGitEnv(entry);',
        'try {',
        `  return runGit(_buildGitArgs("${def.exportName}", args), tmp.env);`,
        '} finally {',
        '  for (const p of tmp.paths) cleanupTemp(p);',
        '}',
      ].filter((line) => line.length > 0);
    } else {
      executeLines = [
        `const gitArgs = _buildGitArgs("${def.exportName}", args);`,
        'return runGit(gitArgs);',
      ];
    }
    const executeBody = executeLines.map((line) => `    ${line}`).join('\n');

    return [
      `export const ${def.exportName} = tool({`,
      `  description: ${JSON.stringify(def.description)},`,
      `  args: {`,
      argLines,
      `  },`,
      `  async execute(args) {`,
      `    // ${def.executeHint}`,
      executeBody,
      `  },`,
      `});`,
    ].join('\n');
  };

  return [
    '/**',
    ' * 平台内置 git 工具族（17 篇 §4.1）——由 worker T5 自动注入。',
    ' * 工具名 = <文件名>_<导出名>（如 git_clone），即权限 action。',
    ' * execute：clone/pull/fetch/push 读取平台下发凭证白名单（~/.keta-git-creds.json），',
    ' * SSH 走 GIT_SSH_COMMAND 临时 key / HTTPS 走 GIT_ASKPASS 临时脚本，try/finally 清理；',
    ' * push 额外校验 write 授权；status/diff/log 本地只读不加载凭证。',
    ' * 凭证面由 server 下发白名单控制，错误信息不含明文 key。',
    ' */',
    'import { tool } from "@opencode-ai/plugin";',
    'import * as child_process from "node:child_process";',
    'import * as crypto from "node:crypto";',
    'import * as fs from "node:fs";',
    'import * as os from "node:os";',
    'import * as path from "node:path";',
    '',
    'const GIT_CREDS_FILE = path.join(os.homedir(), ".keta-git-creds.json");',
    '',
    'interface GitCredentialEntry {',
    '  repoUrl: string;',
    '  authType: string;',
    '  key: string;',
    '  fingerprint?: string;',
    '  permission?: string;',
    '}',
    '',
    normalizeRepoUrl.toString(),
    '',
    loadCredential.toString(),
    '',
    normalizeSshKey.toString(),
    '',
    writeTempKey.toString(),
    '',
    writeAskpass.toString(),
    '',
    cleanupTemp.toString(),
    '',
    buildGitEnv.toString(),
    '',
    runGit.toString(),
    '',
    cwdOrigin.toString(),
    '',
    _buildGitArgs.toString(),
    '',
    ...defs.map(renderTool),
    '',
  ].join('\n');
}

/**
 * 把 git 工具族注入到 opencode serve 工作目录（worker 启动时调用，17 篇 §4.2）。
 * 写入 <workDir>/.opencode/tools/git.ts，返回写入的文件完整路径。
 */
export function installGitTools(workDir: string, defs: readonly GitToolDef[] = GIT_TOOLS): string {
  const toolsDir = path.join(workDir, GIT_TOOLS_REL_DIR);
  fs.mkdirSync(toolsDir, { recursive: true });
  const filePath = path.join(toolsDir, GIT_TOOL_FILE);
  fs.writeFileSync(filePath, renderGitToolsFile(defs), 'utf8');
  return filePath;
}
