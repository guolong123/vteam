import {
  DEFAULT_TASK_WORK_DIR,
  taskDirOf,
  teamDirOf,
  workspaceWorkRoot,
} from './work-dir.util';

/**
 * M2：工作目录空间化。
 * 规则：默认空间（ws_default）保持历史布局；其它空间加 `workspaces/<ws>/` 段。
 */
describe('work-dir.util（工作目录空间化）', () => {
  const ROOT = '/data/vteam-worker';

  it('默认空间 / 未指定空间 → 历史布局（零迁移、零回归）', () => {
    expect(workspaceWorkRoot(ROOT)).toBe(ROOT);
    expect(workspaceWorkRoot(ROOT, 'ws_default')).toBe(ROOT);
    expect(taskDirOf(ROOT, 't_1')).toBe('/data/vteam-worker/tasks/t_1');
    expect(taskDirOf(ROOT, 't_1', 'ws_default')).toBe(
      '/data/vteam-worker/tasks/t_1',
    );
    expect(teamDirOf(ROOT, 'tm_1')).toBe('/data/vteam-worker/teams/tm_1');
  });

  it('非默认空间 → <根>/workspaces/<ws>/...（空间物理隔离）', () => {
    expect(workspaceWorkRoot(ROOT, 'ws_a')).toBe(
      '/data/vteam-worker/workspaces/ws_a',
    );
    expect(taskDirOf(ROOT, 't_1', 'ws_a')).toBe(
      '/data/vteam-worker/workspaces/ws_a/tasks/t_1',
    );
    expect(teamDirOf(ROOT, 'tm_1', 'ws_a')).toBe(
      '/data/vteam-worker/workspaces/ws_a/teams/tm_1',
    );
  });

  it('空间 id 做路径安全清洗（防穿越）、尾斜杠归一', () => {
    expect(workspaceWorkRoot(`${ROOT}/`, 'ws_a')).toBe(
      '/data/vteam-worker/workspaces/ws_a',
    );
    expect(workspaceWorkRoot(ROOT, '../etc')).toBe(
      '/data/vteam-worker/workspaces/etc',
    );
  });

  it('缺省根常量不变（与 worker WORK_DIR 约定一致）', () => {
    expect(DEFAULT_TASK_WORK_DIR).toBe('/data/vteam-worker');
  });
});
