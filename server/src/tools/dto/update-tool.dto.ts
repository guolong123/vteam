import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsObject, IsOptional } from 'class-validator';

/**
 * PATCH /tools/:id 请求体（09 §3.8 契约对齐：仅 {schema?, initCommand?, enabled?}）。
 * **不更新 name/action/execution/source/mcpServer**——工具定义注册后不可改
 * （工具名即权限 action，FR-48），本版以 enabled=false 停用替代修改。
 * 收敛后 update 不再做 action 唯一校验（action 不可更新，仅 POST 时校验）。
 */
export class UpdateToolDto {
  @ApiPropertyOptional({ description: '输入/输出 JSON Schema', type: Object })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '初始化命令/脚本列表（Json 数组）', type: [Object] })
  @IsOptional()
  @IsArray()
  initCommand?: Array<Record<string, unknown>>;

  @ApiPropertyOptional({ description: '是否启用（false=停用）' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
