import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { TASK_PRIORITY } from '../../common/constants/task.constants';

/**
 * 团队成员实例输入（FR-08 角色/实例分离 T2）：
 * 同一 agentId 可重复出现 = 同一模板 agent 添加多个实例（服务端生成 seq，
 * 事务内 `max(seq)+1` 防并发重号），alias 缺省 = `<角色中文名>-<seq>`（如 开发者-1）。
 */
export class TaskAgentInput {
  @ApiProperty({
    description: '模板 Agent id（同一 agent 可添加多个实例，服务端生成 seq）',
  })
  @IsString()
  agentId: string;

  @ApiPropertyOptional({
    description: '实例别名（缺省 = `<角色中文名>-<seq>`，如 开发者-1）',
  })
  @IsOptional()
  @IsString()
  alias?: string;

  @ApiPropertyOptional({
    description:
      '实例独立持久化工作目录（缺省 = `/data/worker/<sanitize(agent.name)>`，同 agent 多实例追加 -<seq>）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;
}

/**
 * POST /projects/:pid/tasks 请求体（09 篇 §3.4 Tasks 创建）。
 * agents[] 为初始团队实例列表；主 Agent 指向实例（mainAgentInstanceId，
 * 决策依据），mainAgentId 保留兼容映射（缺省时按 mainAgentId 映射到该 agent
 * 第一个实例），均须属于本次创建实例集合（服务层校验，FR-08）。
 */
export class CreateTaskDto {
  @ApiProperty({ description: '任务标题（创建必填）', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  title: string;

  @ApiPropertyOptional({ description: '任务描述（可选）' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: '优先级（high/medium/low，默认 medium）',
    enum: Object.values(TASK_PRIORITY),
    default: TASK_PRIORITY.medium,
  })
  @IsOptional()
  @IsIn(Object.values(TASK_PRIORITY))
  priority?: string;

  @ApiProperty({
    description: '初始团队实例列表（FR-02；agentId 可重复 = 多实例）',
    type: [TaskAgentInput],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => TaskAgentInput)
  agents: TaskAgentInput[];

  @ApiPropertyOptional({
    description:
      '主 Agent 实例 id（FR-08 决策依据），须属于本次创建实例集合；缺省时按 mainAgentId 映射到该 agent 第一个实例',
  })
  @IsOptional()
  @IsString()
  mainAgentInstanceId?: string;

  @ApiPropertyOptional({
    description:
      '主 Agent id（FR-08 兼容映射：mainAgentInstanceId 缺省时按其映射到该 agent 第一个实例）',
  })
  @IsOptional()
  @IsString()
  mainAgentId?: string;

  @ApiPropertyOptional({
    description: '背景文档元数据数组（FR-06，存 tasks.background_docs Json）',
  })
  @IsOptional()
  @IsArray()
  backgroundDocs?: unknown[];
}
