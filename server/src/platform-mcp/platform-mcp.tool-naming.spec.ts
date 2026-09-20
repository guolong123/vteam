import { VTEAM_MCP_TOOL_NAMES } from '../common/constants/agent.constants';
import { buildPlatformMcpTools, zodObjectToJsonSchema } from './platform-mcp.tools';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * 命名 + 身份契约断言（opencode-native-permissions-and-fixes todo 1；契约与实证见
 * `CONTRACT-tool-naming-and-identity.md` 与
 * `.omo/evidence/opencode-native-permissions-and-fixes/task-1-identity-and-naming.json`）。
 *
 * 实证事实：`tools/call` 服务端收到的是**裸名**（`doclib`），模型侧呈现名才是
 * `vteam_doclib`；而策略矩阵（`VTEAM_MCP_TOOL_NAMES` / `ROLE_BOUNDARIES[*].toolAllows`）
 * 的键是 `vteam_<action>`。故 todo 3 的检查必须以 `vteam_${receivedName}` 查矩阵。
 * 断言分两半守住该契约：命名集合三处相等；身份字段表与实证一致（schema 漂移即失效）。
 */
describe('platform-mcp tool naming contract', () => {
  const service = {} as PlatformMcpService;
  const registered = buildPlatformMcpTools(service).map((t) => t.name);

  it('注册名 == 矩阵裸名 == VTEAM_MCP_TOOL_NAMES 去前缀（全裸名、一一对应）', () => {
    const matrixBare = VTEAM_MCP_TOOL_NAMES.map((n) => n.replace(/^vteam_/, ''));
    expect([...registered].sort()).toEqual([...matrixBare].sort());
    expect(registered.every((n) => !n.startsWith('vteam_'))).toBe(true);
    expect(registered.every((n) => VTEAM_MCP_TOOL_NAMES.includes(`vteam_${n}`))).toBe(true);
    expect(new Set(VTEAM_MCP_TOOL_NAMES).size).toBe(VTEAM_MCP_TOOL_NAMES.length);
  });

  it('矩阵键不是裸名（防止用裸名查矩阵导致全量 403）', () => {
    expect(VTEAM_MCP_TOOL_NAMES.some((n) => registered.includes(n))).toBe(false);
  });

  it('身份字段表与 todo 1 实证一致（schema 漂移即失效）', () => {
    const REQUIRED = 'required';
    const OPTIONAL = 'optional';
    const ABSENT = 'absent';
    const expected: Record<string, Record<string, string>> = {
      chat_history: { selfInstanceId: OPTIONAL, teamId: OPTIONAL, taskId: OPTIONAL },
      doclib: { selfInstanceId: ABSENT, teamId: ABSENT, taskId: REQUIRED },
      task_context: { selfInstanceId: ABSENT, teamId: ABSENT, taskId: REQUIRED },
      group_post: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      read_file: { selfInstanceId: ABSENT, teamId: ABSENT, taskId: REQUIRED },
      notify_agent: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      submit_artifact: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      issue_create: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      issue_list: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      issue_get: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      issue_update: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      issue_transition: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      task_transition: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      question_confirm: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      memory_save: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      memory_update: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      memory_search: { selfInstanceId: ABSENT, teamId: OPTIONAL, taskId: OPTIONAL },
      team_view: { selfInstanceId: ABSENT, teamId: ABSENT, taskId: REQUIRED },
      my_profile: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      team_add_member: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      plan_mode: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      plan_complete: { selfInstanceId: REQUIRED, teamId: ABSENT, taskId: REQUIRED },
      channel_send: { selfInstanceId: ABSENT, teamId: ABSENT, taskId: ABSENT },
      wecom_reply: { selfInstanceId: OPTIONAL, teamId: ABSENT, taskId: OPTIONAL },
      task_create: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      skill_create: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      git_repos_list: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      hook_register: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
      hook_cancel: { selfInstanceId: REQUIRED, teamId: OPTIONAL, taskId: OPTIONAL },
    };

    const observed: Record<string, Record<string, string>> = {};
    for (const tool of buildPlatformMcpTools(service)) {
      const { properties, required } = zodObjectToJsonSchema(tool.inputSchema);
      const requiredSet = new Set(required);
      observed[tool.name] = Object.fromEntries(
        ['selfInstanceId', 'teamId', 'taskId'].map((key) => [
          key,
          !(key in properties) ? ABSENT : requiredSet.has(key) ? REQUIRED : OPTIONAL,
        ]),
      );
    }

    expect(observed).toEqual(expected);
  });
});
