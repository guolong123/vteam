import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * worker 镜像 PID1 reaper 契约（僵尸进程修复，2026-11-10）
 * =============================================
 * 实测症状：容器 PID1 = `node dist/index.js` 时，agent-browser/Chrome 的子进程在
 * 父进程退出后被 reparent 到 PID1；它们随后退出时 node 不 wait() ⇒ 形成 `Z`
 * （defunct，PPID=1）僵尸。一次「打开→截图→关闭」稳定 +20 个，RSS=0 但 PID 表
 * 持续占位，最终会打满容器 pid 限额。修复 = 镜像入口用 tini 当 PID1（k8s 无法
 * 传 `--init`，只能靠镜像 ENTRYPOINT）；compose 另开 `init: true` 双保险。
 *
 * 本 spec 是回归护栏：避免后续重构 Dockerfile 时静默把 tini/ENTRYPOINT 弄丢
 * ——这类回归只在线上跑一阵子后（僵尸堆满）才暴露，这里用静态断言提前拦住。
 */
describe('worker 镜像 PID1 reaper 契约', () => {
  const workerDir = resolve(__dirname, '..');
  const readWorkerFile = (file: string): string =>
    readFileSync(resolve(workerDir, file), 'utf8');

  it.each([
    // opencode worker：CMD 是启动脚本（同步 /opt 下的 Chrome 到 PVC 的 /root，再 exec node）。
    ['Dockerfile', '"/usr/local/bin/worker-entrypoint.sh"'],
    // dsh worker 不装 agent-browser/Chrome，CMD 保持直跑 node。
    ['Dockerfile.dsh', '"node", "dist/index.js"'],
  ])(
    '%s：安装 tini，且以 tini 作为 ENTRYPOINT（CMD 保留为 %s）',
    (file, expectedCmd) => {
      const text = readWorkerFile(file);
      // tini 必须真的装进镜像（apt 包），否则 ENTRYPOINT 会启动失败。
      expect(text).toMatch(/apt-get install[\s\S]*?\btini\b/);
      expect(text).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
      expect(text).toContain(`CMD [${expectedCmd}]`);
      // ENTRYPOINT 必须在 CMD 之前，否则 CMD 被当作 ENTRYPOINT 参数语义错位。
      expect(text.indexOf('ENTRYPOINT ["/usr/bin/tini"')).toBeLessThan(
        text.indexOf('CMD ["'),
      );
    },
  );

  it('worker 镜像显式安装 Chrome 运行库，不依赖无 sudo 环境下的 --with-deps', () => {
    const text = readWorkerFile('Dockerfile');
    // 2026-11-10 线上回归：--with-deps 内部 sudo apt 失败但仍 exit 0 ⇒ 只下 Chrome 不装库，
    // 运行期 Chrome 报 libglib-2.0.so.0 等 24 个库缺失。必须显式 apt 安装 + 构建期验收可执行。
    expect(text).toContain('libglib2.0-0');
    expect(text).toContain('libnss3');
    expect(text).not.toMatch(/^\s*if agent-browser install --with-deps;/m);
    // Chrome 放在 /opt（镜像层），避免被 k8s 的 /root PVC 遮住；启动脚本负责链回 state dir。
    expect(text).toContain('/opt/agent-browser');
  });

  it('worker-entrypoint.sh：把 /opt 下的浏览器链回 /root/.agent-browser 后 exec node', () => {
    const text = readWorkerFile('docker/worker-entrypoint.sh');
    expect(text).toContain('BROWSERS_DIR="/opt/agent-browser/browsers"');
    expect(text).toContain('/root/.agent-browser/browsers');
    expect(text).toContain('exec node dist/index.js');
  });

  it('docker-compose 的 worker 服务显式 init: true（旧镜像/自定义 entrypoint 双保险）', () => {
    const compose = readFileSync(
      resolve(workerDir, '..', 'docker-compose.yml'),
      'utf8',
    );
    const workerIndex = compose.indexOf('\n  worker:');
    expect(workerIndex).toBeGreaterThan(-1);
    // worker 是 compose 最后一个服务；从它的段首到文件尾断言即可。
    expect(compose.slice(workerIndex)).toContain('init: true');
  });
});
