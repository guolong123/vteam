import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * PATCH /workers/:id 请求体（C8：worker 默认模型配置；maxInstances：管理员改并发上限）。
 * defaultModelId 为 `providerID/modelID` 格式（对齐 worker 上报 id 与 models 目录 ref）；
 * - 非空：须存在于 models 目录且 enabled（否则 400 MODEL_NOT_FOUND）；
 * - null：清除默认模型；
 * - 缺省：幂等跳过（不更新）。
 * maxInstances 为 worker 并发上限（1..64）；null/缺省表示不修改。
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

  @ApiPropertyOptional({
    description: 'worker 并发上限（≥1；null 表示不修改）',
    minimum: 1,
    maximum: 64,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  maxInstances?: number | null;
}
