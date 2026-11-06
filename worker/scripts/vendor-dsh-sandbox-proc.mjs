#!/usr/bin/env node
/**
 * 补丁：DSH 沙箱的 bwrap profile 去掉 `--proc /proc`（构建期，幂等）。
 *
 * 背景（2026-11-06 实测，本集群 k8s）：
 *   DSH 的本地沙箱后端链是 bwrap → landlock（dsh-sandbox-local/lib/index.js）。
 *   bwrap 的 profile 固定创建新 PID namespace 并**重新挂载一个 procfs**：
 *       --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
 *   而本集群内核（4.18 RHEL8 / 6.5 elrepo）**拒绝在非初始 user namespace 里挂 procfs**：
 *       bwrap: Can't mount proc on /newroot/proc: Operation not permitted
 *   ⇒ bwrap 探针失败（DSH 只认 exit status）⇒ 回退 landlock，而内核未启用
 *   CONFIG_SECURITY_LANDLOCK ⇒ 两个后端全挂 ⇒ 默认 workspace-write 模式下
 *   bash 直接失败（`sandbox mode "workspace-write" is requested but no sandbox backend`），
 *   用户只能开 danger-full-access。
 *
 * 为什么不改成「加 CAP_SYS_ADMIN」：那条路要求容器以 **root** 运行（非 root 下 cap 会被
 *   丢弃，实测 CapEff=0），等于把一个执行 Agent 命令的容器提权到可 mount/ptrace；
 *   而非 root + 本补丁的组合经实测**沙箱仍然有效**（/etc 只读、只能写 workspace），
 *   是最小权限解。
 *
 * 补丁内容：去掉 `--proc /proc` 两项，保留 `--unshare-pid`（进程可见性/信号隔离不变）。
 *   沙箱内 `/proc` 由 `--ro-bind / /` 带进来的只读 procfs 提供，功能可用（ps 等可读），
 *   只是看到的是容器 pid namespace 的视图。
 *
 * 锚点漂移 ⇒ 构建失败（而不是运行期静默失去沙箱）——与本仓库既有的
 *   `scripts/vendor-sdk-server.mjs` 同一约定。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 定位全局安装的 dsh-sandbox-local（随 @deepseek-ai/dsh 一起装）。 */
function resolveSandboxModule() {
  // 全局 npm root（dsh 是 npm i -g 装的）
  const globalRoot = execFileSync('npm', ['root', '-g'], {
    encoding: 'utf8',
  }).trim();
  const candidates = [
    path.join(
      globalRoot,
      '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js',
    ),
    path.join(
      globalRoot,
      '@deepseek-ai/dsh-sandbox-local/lib/index.js',
    ),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // 试下一个
    }
  }
  throw new Error(
    `dsh-sandbox-local 未找到（尝试过：\n  ${candidates.join('\n  ')}\n）`,
  );
}

/** 需要被替换的原始片段（含缩进，锚点必须精确）。 */
const ORIGINAL = [
  '\t\t"--dev",',
  '\t\t"/dev",',
  '\t\t"--unshare-pid",',
  '\t\t"--proc",',
  '\t\t"/proc",',
  '\t\t"--die-with-parent"',
].join('\n');

/** 补丁后的片段：去掉 --proc /proc，保留 --unshare-pid。 */
const PATCHED = [
  '\t\t"--dev",',
  '\t\t"/dev",',
  '\t\t"--unshare-pid",',
  '\t\t"--die-with-parent"',
].join('\n');

const MARKER = '// vteam-patch: no-proc-mount';

function main() {
  const file = resolveSandboxModule();
  const source = readFileSync(file, 'utf8');

  if (source.includes(MARKER)) {
    console.log(`[vendor-dsh-sandbox] 已打过补丁，跳过: ${file}`);
    return;
  }

  const occurrences = source.split(ORIGINAL).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[vendor-dsh-sandbox] 锚点漂移：期望 1 处 bwrap profile，实际 ${occurrences} 处\n` +
        `  file=${file}\n` +
        `  说明：上游 dsh 版本变了，请人工核对新 profile 后更新本脚本（构建失败是刻意的）。`,
    );
  }

  const patched = source.replace(
    ORIGINAL,
    `${PATCHED}\n\t\t// ${MARKER.slice(3)}: 本集群内核拒绝在非初始 userns 里挂 procfs；\n` +
      '\t\t// /proc 由 --ro-bind / / 带入的只读 procfs 提供（详见 worker/scripts/vendor-dsh-sandbox-proc.mjs）',
  );
  writeFileSync(file, patched, 'utf8');
  console.log(`[vendor-dsh-sandbox] 已应用 no-proc 补丁: ${file}`);
}

main();
