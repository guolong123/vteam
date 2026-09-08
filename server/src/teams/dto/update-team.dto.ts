import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateTeamDto {
  @ApiPropertyOptional({ description: '团队名称（全局唯一）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '团队描述' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: '是否复用会话' })
  @IsOptional()
  @IsBoolean()
  reuseSession?: boolean;

  @ApiPropertyOptional({
    description:
      '托管模式（默认 false）：开启后成员 question/permission 请求不弹窗给用户，改由主 Agent 经 question_confirm 确认',
  })
  @IsOptional()
  @IsBoolean()
  managedMode?: boolean;

  @ApiPropertyOptional({
    description: '主 Agent 成员 id（须属于该团队，null 清空，★）',
  })
  @IsOptional()
  @ValidateIf((o) => o.mainAgentMemberId !== null)
  @IsString()
  mainAgentMemberId?: string | null;

  @ApiPropertyOptional({ description: '乐观锁版本号（并发写保护）' })
  @IsOptional()
  @IsInt()
  version?: number;
}
