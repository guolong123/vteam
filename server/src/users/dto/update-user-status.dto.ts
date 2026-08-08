import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * PATCH /users/:id/status 请求体（FR-22 禁用/启用）。
 * body 形如 `{ enabled: boolean }`。
 */
export class UpdateUserStatusDto {
  @ApiProperty({ description: 'true 启用 / false 禁用', example: true })
  @IsBoolean()
  enabled: boolean;
}
