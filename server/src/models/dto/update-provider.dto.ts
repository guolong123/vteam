import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MODEL_PROVIDER_TYPES } from '../models.constants';

/**
 * PATCH /models/providers/:providerID 请求体（Provider 级配置更新，C7）。
 * 与 UpdateModelDto 的差异（为何需要独立 DTO/端点，详见 service.updateProvider 注释）：
 * - baseUrl 允许显式 null = 清空（cloud 可去掉自定义端点）；本 DTO 不挂 @Matches——
 *   空串/非 http(s) 的判定统一交给 normalizeBaseUrl（local/custom 必填、cloud 可空）；
 * - providerType 取 MODEL_PROVIDER_TYPES（cloud|local|custom），与目录 CRUD 同源。
 * 两字段皆缺省 = 无更新内容（service 抛 400）。
 */
export class UpdateProviderDto {
  @ApiPropertyOptional({
    description: 'Provider 类型（cloud|local|custom）',
    enum: MODEL_PROVIDER_TYPES,
  })
  @IsOptional()
  @IsString()
  @IsIn([...MODEL_PROVIDER_TYPES], {
    message: 'providerType 需为 cloud|local|custom',
  })
  providerType?: string;

  @ApiPropertyOptional({
    description:
      'local/custom 必填（http(s) URL）；cloud 可空，null/空串 = 清空自定义端点',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  baseUrl?: string | null;

  /**
   * provider 级**固定请求头**（键值对）。null/{} = 清空。
   *
   * 典型用例：opencode-go 网关要求 `x-opencode-session`（实测：裸请求报
   * MissingSessionID；加头立即通过；body 里放 user/safety_identifier 无效）。
   * 值必须是**静态**字符串（不放密钥——密钥走凭据通道）。
   */
  @ApiPropertyOptional({
    description:
      'provider 级固定请求头（如 {"x-opencode-session":"vteam"}）；null/{} = 清空。值需为静态串，密钥请走凭据接口',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string> | null;
}
