import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PolicyConfigDto } from './policy-config.dto';

/**
 * POST /execution-policies 请求体（Todo 11）。
 * 仅允许创建 `type='custom'`：`template` 为平台内置角色策略（seed 维护，写操作 403）。
 */
export class CreateExecutionPolicyDto {
  @ApiProperty({ description: '策略名称', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @ApiPropertyOptional({ description: '策略描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: '策略类型（POST 仅支持 custom；template 为平台内置只读）',
    enum: ['custom'],
  })
  @IsIn(['custom'])
  type: 'custom';

  @ApiProperty({
    description: '策略配置（嵌套 permission/correction，两者均须为对象）',
    type: PolicyConfigDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => PolicyConfigDto)
  config: PolicyConfigDto;
}
