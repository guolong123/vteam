import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AddMemberDto {
  @ApiProperty({ description: '模板 Agent id' })
  @IsString()
  agentId: string;

  @ApiPropertyOptional({
    description: '实例别名（缺省 = `<角色中文名>-<seq>`）',
  })
  @IsOptional()
  @IsString()
  alias?: string;

  @ApiPropertyOptional({
    description: '实例持久化工作目录（缺省自动生成）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ description: '实例别名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  alias?: string;

  @ApiPropertyOptional({ description: '实例持久化工作目录' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;
}
