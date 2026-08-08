import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * POST /models/:id/credentials 请求体。
 * token 明文仅存在于请求体与加密存储（AES-256-GCM），
 * 不进入任何日志/审计事件/响应（fingerprint 脱敏替代，17 篇 §3.4）。
 * providerID 可选：缺省取该 model 的 providerID；显式提供时须与 model 一致
 * （校验一致决策，避免 GET 按 model.providerID 查不到，C4）。
 */
export class SetModelCredentialDto {
  @ApiProperty({
    description: '模型 provider API token（明文仅请求体与加密存储，响应只出 fingerprint）',
    example: 'sk-xxxxxxxxxxxxxxxx',
    maxLength: 4096,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  @Matches(/\S/, { message: 'token 不能为空白字符' })
  token: string;

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
}
