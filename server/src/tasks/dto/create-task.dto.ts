import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TASK_PRIORITY } from '../../common/constants/task.constants';

/**
 * POST /tasks 请求体（仅 teamId 必填，指派全局团队）。
 * 移除 agents/mainAgentId/mainAgentInstanceId（不再由任务侧组建团队，改为快照 Team 成员）。
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

  @ApiProperty({ description: '指派团队 id（全局 Team 必填）' })
  @IsString()
  teamId: string;

  @ApiPropertyOptional({
    description: '背景文档元数据数组（FR-06，存 tasks.background_docs Json）',
  })
  @IsOptional()
  @IsArray()
  backgroundDocs?: unknown[];

  @ApiPropertyOptional({
    description:
      '完成后为下一任务开新会话（覆盖 Team.reuseSession，默认 false）',
  })
  @IsOptional()
  @IsBoolean()
  resetAfterComplete?: boolean;

  @ApiPropertyOptional({
    description:
      '计划模式（默认 false=直接执行；true=主 Agent 先出计划文档，其他成员只评审不起草）',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  planMode?: boolean;
}
