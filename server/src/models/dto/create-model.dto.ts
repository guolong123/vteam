import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** providerID/modelID slug 格式（对齐 mcp-servers name：小写字母/数字开头 + 小写/数字/连字符/下划线/点）。 */
export const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/;

/**
 * POST /models 请求体（C3 目录 CRUD）。
 * - providerID + modelID 构成唯一键（@@unique uk_models_provider_model），
 *   service 层先查撞冲突 → 409 MODEL_EXISTS；
 * - capabilities 可选（模型能力声明 Json，worker 上报合并时留空缺省）。
 */
export class CreateModelDto {
  @ApiProperty({
    description: '模型 provider 标识（如 opencode-go；slug 小写字母/数字开头）',
    example: 'opencode-go',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(MODEL_SLUG_PATTERN, {
    message: 'providerID 需为小写字母/数字/连字符/下划线/点（如 opencode-go）',
  })
  providerID: string;

  @ApiProperty({
    description: '模型标识（如 deepseek-v4-flash；slug 小写字母/数字开头）',
    example: 'deepseek-v4-flash',
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(MODEL_SLUG_PATTERN, {
    message: 'modelID 需为小写字母/数字/连字符/下划线/点（如 deepseek-v4-flash）',
  })
  modelID: string;

  @ApiProperty({ description: '模型显示名', example: 'DeepSeek V4 Flash', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  @ApiPropertyOptional({
    description: '模型能力声明（Json，可选）',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '是否启用（false=停用，available-models 只出 enabled）', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
