import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MODEL_SLUG_PATTERN } from './create-model.dto';

/**
 * PATCH /models/:id 请求体（C3 目录 CRUD，全可选部分更新）。
 * 改 providerID/modelID 撞 @@unique → service 层 409 MODEL_EXISTS（排除自身）。
 */
export class UpdateModelDto {
  @ApiPropertyOptional({
    description: '模型 provider 标识（slug）',
    example: 'opencode-go',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(MODEL_SLUG_PATTERN, {
    message: 'providerID 需为小写字母/数字/连字符/下划线/点（如 opencode-go）',
  })
  providerID?: string;

  @ApiPropertyOptional({
    description: '模型标识（slug）',
    example: 'deepseek-v4-flash',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(MODEL_SLUG_PATTERN, {
    message: 'modelID 需为小写字母/数字/连字符/下划线/点（如 deepseek-v4-flash）',
  })
  modelID?: string;

  @ApiPropertyOptional({ description: '模型显示名', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({ description: '模型能力声明（Json）', type: Object })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '是否启用（false=停用）' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
