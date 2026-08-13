import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * PATCH /issues/:id 请求体（全 optional 部分更新）。
 * assigneeAgentId/assigneeUserId 传 null 表示清除指派；assigneeAgentId 变更时
 * 服务层重新校验新 Agent 是否在任务团队未 removed。
 */
export class UpdateIssueDto {
  @ApiPropertyOptional({ description: 'issue 标题', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  title?: string;

  @ApiPropertyOptional({ description: 'issue 描述（null 清除）' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({
    description: '标签（字符串数组）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: '指派 Agent id（null 清除；变更须在任务团队未 removed）',
  })
  @IsOptional()
  @IsString()
  assigneeAgentId?: string | null;

  @ApiPropertyOptional({ description: '指派用户 id（null 清除）' })
  @IsOptional()
  @IsString()
  assigneeUserId?: string | null;
}
