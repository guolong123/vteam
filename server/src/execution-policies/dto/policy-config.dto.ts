import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * ExecutionPolicy.config 请求体（新嵌套形状，vteam-role-behavior-enforcement Todo 11）。
 *
 * 单一形状来源是 seed（commit fef82fe）落库的 `{ permission, correction }`：
 * - `permission`：层① opencode agent 权限（嵌套；`edit`/`read` 为路径 glob map，
 *   `bash`/`task`/`vteam_<action>` 为 allow|ask|deny）；
 * - `correction`：层② guard 越界纠正（`scopeSummary`/`handoff`/`denyTemplate`）；
 * - `tools` / `bashDeny`：层② guard 可选字段（三态工具矩阵 / bash 拒绝模式字符串数组），
 *   缺失合法；显式传入时按各自 DTO 声明校验（全局 whitelist 不再静默剥离）。
 *
 * DTO 只强制两者均为**对象**（拒绝非对象/缺失/数组），键值语义由
 * `ROLE_BOUNDARIES`（agent.constants.ts）+ seed 保证；旧的
 * `{ permissions, writePaths }` 形状已废弃，解析层会拒绝（execution-policy.service.ts）。
 */
export class PolicyConfigDto {
  @ApiProperty({
    description:
      '层① opencode permission（嵌套对象：edit/read 路径 glob map + bash/task + vteam_<action> deny）',
    type: Object,
    example: {
      edit: { '*': 'deny', '**tasks/*/docs/**': 'allow' },
      read: { '*': 'allow' },
      bash: 'ask',
      task: 'deny',
      vteam_notify_agent: 'deny',
    },
  })
  @IsObject()
  permission: Record<string, unknown>;

  @ApiProperty({
    description:
      '层② guard 纠正配置（correction 对象：scopeSummary/handoff/denyTemplate）',
    type: Object,
    example: {
      scopeSummary: '需求分析与原型设计……',
      handoff: { code: 'vteam-developer' },
      denyTemplate: '【越界拦截｜角色：{role}】不能调用 <tool>……',
    },
  })
  @IsObject()
  correction: Record<string, unknown>;

  @ApiProperty({
    description:
      '层② guard 三态工具矩阵（可选；键为工具真实名，值为 allow|ask|deny；自定义 agent 专属，内置策略行缺失合法）',
    type: Object,
    required: false,
    example: {
      vteam_group_post: 'allow',
      vteam_member_remove: 'deny',
    },
  })
  @IsOptional()
  @IsObject()
  tools?: Record<string, 'allow' | 'ask' | 'deny'>;

  @ApiProperty({
    description:
      '层② guard bash 命令拒绝模式（可选；字符串数组；缺省回退 ROLE_BASH_DENY_PATTERNS）',
    type: [String],
    required: false,
    example: ['rm -rf /'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bashDeny?: string[];
}
