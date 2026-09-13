import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PolicyConfigDto } from './policy-config.dto';

/**
 * PATCH /execution-policies/:id 请求体（Todo 11）。
 * 全字段可选；`config` 显式传入时仍须满足嵌套 `permission`/`correction` 均为对象
 * （不接受半更新后的残缺配置）。type 不可改（不在 DTO，天然安全红线）。
 */
export class UpdateExecutionPolicyDto {
  @ApiPropertyOptional({ description: '策略名称', maxLength: 128 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({ description: '策略描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      '策略配置（显式传入时 permission/correction 均须为对象；不传保持原配置）',
    type: PolicyConfigDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PolicyConfigDto)
  config?: PolicyConfigDto;
}
