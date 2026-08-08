import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * PATCH /workers/:id 请求体（C8：worker 默认模型配置）。
 * defaultModelId 为 `providerID/modelID` 格式（对齐 worker 上报 id 与 models 目录 ref）；
 * - 非空：须存在于 models 目录且 enabled（否则 400 MODEL_NOT_FOUND）；
 * - null：清除默认模型；
 * - 缺省：幂等跳过（不更新）。
 */
export class UpdateWorkerModelDto {
  @ApiPropertyOptional({
    description:
      '默认模型 id（providerID/modelID，须存在于可用模型目录；null=清除；缺省=不更新）',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  defaultModelId?: string | null;
}
