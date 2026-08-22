import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * POST /models/:id/credentials 请求体。
 * token 明文仅存在于请求体与加密存储（AES-256-GCM），
 * 不进入任何日志/审计事件/响应（fingerprint 脱敏替代，17 篇 §3.4）。
 * providerID 可选：缺省取该 model 的 providerID；显式提供时须与 model 一致
 * （校验一致决策，避免 GET 按 model.providerID 查不到，C4）。
 */
export class SetModelCredentialDto {
  @ApiPropertyOptional({
    description: '模型 provider API token（明文仅请求体与加密存储，响应只出 fingerprint；本地无鉴权可为空）',
    example: 'sk-xxxxxxxxxxxxxxxx',
    maxLength: 4096,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @ValidateIf((o) => typeof o.token === 'string' && o.token.trim().length > 0)
  @Matches(/\S/, { message: 'token 不能为空白字符' })
  @ValidateIf((o) => typeof o.token === 'string' && o.token.trim().length > 0)
  @Matches(/^sk-[A-Za-z0-9_-]{8,}$/, {
    message: 'token 需以 sk- 开头且至少 8 位（仅含字母/数字/下划线/连字符）',
  })
  token?: string;

  @ApiPropertyOptional({
    description:
      'provider 粒度（可选）：缺省取该 model 的 providerID；提供时须与 model 一致（否则 400）',
    example: 'opencode-go',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  providerID?: string;

  @ApiPropertyOptional({
    description:
      'C5 凭据下发定向 worker 列表（可选）：空/缺省 = 全量广播到所有在线 worker；非空 = 仅下发到指定 worker（enqueueCommand 精确下发）',
    example: ['w_0000000001'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  targetWorkerIds?: string[];
}
