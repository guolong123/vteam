import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateInstanceDto {
  @ApiPropertyOptional({
    description: '是否启用（false=禁用，禁用后无法接收消息）',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: '覆盖模型ID（provider/model，空字符串表示跟随模板）',
  })
  @IsOptional()
  @IsString()
  overrideModelId?: string | null;
}
