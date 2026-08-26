import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** providerID slug 格式（对齐 mcp-servers name：小写字母/数字开头 + 小写/数字/连字符/下划线/点）。 */
export const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/;
/** modelID 允许含冒号的本地标签（如 ollama 的 ornith-1.5:9b、llama3:8b）。 */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9-_.:]*$/;

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
    description: '模型标识（如 ornith-1.5:9b；支持冒号的本地标签）',
    example: 'ornith-1.5:9b',
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(MODEL_ID_PATTERN, {
    message:
      'modelID 需为小写字母/数字/连字符/下划线/点/冒号（如 ornith-1.5:9b）',
  })
  modelID: string;

  @ApiProperty({
    description: '模型显示名',
    example: 'DeepSeek V4 Flash',
    maxLength: 128,
  })
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

  @ApiPropertyOptional({
    description: '是否启用（false=停用，available-models 只出 enabled）',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      '模型 provider 类型（cloud 云端 | local 本地 | custom 自定义）',
    example: 'cloud',
    enum: ['cloud', 'local', 'custom'],
    default: 'cloud',
  })
  @IsOptional()
  @IsString()
  @IsIn(['cloud', 'local', 'custom'])
  providerType?: string;

  @ApiPropertyOptional({
    description: '本地/自定义模型 baseUrl（local/custom 必填，http(s) URL）',
    example: 'http://host.docker.internal:11434/v1',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^https?:\/\/.+/, { message: 'baseUrl 需为 http(s) URL' })
  baseUrl?: string;
}
