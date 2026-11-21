import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * 更新单个平台配置的入参（PATCH /platform-configs/:key）。
 * 键在路径参数中，值按该键的 valueType 在服务层校验。
 */
export class UpdatePlatformConfigDto {
  @ApiProperty({
    description: '配置值（字符串形态提交；服务层按该键的 valueType 解析校验）',
    example: '5',
  })
  @IsString()
  value: string;
}

/**
 * 批量更新平台配置（PATCH /platform-configs）。
 * 事务语义：任一键校验失败 → 整体回滚，不落部分更新。
 */
export class UpdatePlatformConfigsDto {
  @ApiProperty({
    description: '键值对（键须在白名单内，值按该键类型校验）',
    example: {
      SESSION_COMPACT_IDLE_DAYS: '5',
      SESSION_COMPACT_AWAIT_MS: '60000',
    },
  })
  @IsOptional()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configs?: Record<string, any>;
}
