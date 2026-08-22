import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateInstanceDto {
  @ApiPropertyOptional({ description: '是否启用（false=禁用，禁用后无法接收消息）' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
