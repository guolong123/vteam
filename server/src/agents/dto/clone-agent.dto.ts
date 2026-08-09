import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /agents/:id/clone 请求体（09 篇 §3.7 FR-31）。
 * name 缺省时服务层以「源名称 + 副本」命名。
 */
export class CloneAgentDto {
  @ApiPropertyOptional({ description: '克隆副本名称（缺省源名称+「副本」）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;
}
