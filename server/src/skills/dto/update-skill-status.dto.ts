import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * PATCH /skills/:id/status 请求体（09 篇 §3.8 启停专用端点）。
 * enabled 必填布尔：true 启用 / false 停用（停用后已勾选该技能的 Agent 不再注入）。
 */
export class UpdateSkillStatusDto {
  @ApiProperty({ description: '启用状态（true 启用 / false 停用）' })
  @IsBoolean()
  enabled: boolean;
}
