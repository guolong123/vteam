import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  ValidateNested,
} from 'class-validator';
import { MODEL_MODALITIES } from '../models.constants';

/** limit 子对象（context/output 均为正整数 token 数）。 */
export class ModelLimitDto {
  @ApiPropertyOptional({ description: '上下文窗口 token 数（正整数）' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  context?: number;

  @ApiPropertyOptional({ description: '最大输出 token 数（正整数）' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  output?: number;
}

/** modalities 子对象（枚举白名单，见 MODEL_MODALITIES）。 */
export class ModelModalitiesDto {
  @ApiPropertyOptional({
    description: '输入模态',
    enum: MODEL_MODALITIES,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsIn([...MODEL_MODALITIES], { each: true })
  input?: string[];

  @ApiPropertyOptional({
    description: '输出模态',
    enum: MODEL_MODALITIES,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsIn([...MODEL_MODALITIES], { each: true })
  output?: string[];
}

/**
 * C8：per-model 能力声明（`Model.capabilities` Json 的受校验形状）。
 *
 * 为何校验而非继续用 `@IsObject` 任意 JSON：这些值会**原样写进 worker 的
 * opencode.json**——opencode 的模型对象是 additionalProperties:false 且 `limit`
 * 声明 required:[context,output]，脏值会让配置解析抛 InvalidError（风险是
 * serve 起不来）。故在此挡在入口：未知键被 ValidationPipe whitelist 剥离，
 * 类型/取值错误直接 400。
 *
 * 字段语义见 models.constants.ts 的 ModelCapabilities 注释
 * （`limit.context` 不配 = 0 → 该模型自动压缩失效，是最关键的一项）。
 */
export class ModelCapabilitiesDto {
  @ApiPropertyOptional({ description: 'token 上限', type: ModelLimitDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ModelLimitDto)
  limit?: ModelLimitDto;

  @ApiPropertyOptional({ description: '是否支持推理/思考' })
  @IsOptional()
  @IsBoolean()
  reasoning?: boolean;

  @ApiPropertyOptional({ description: '是否支持工具调用' })
  @IsOptional()
  @IsBoolean()
  toolCall?: boolean;

  @ApiPropertyOptional({ description: '是否接受 temperature 参数' })
  @IsOptional()
  @IsBoolean()
  temperature?: boolean;

  @ApiPropertyOptional({ description: '是否接受附件' })
  @IsOptional()
  @IsBoolean()
  attachment?: boolean;

  @ApiPropertyOptional({
    description: '输入/输出模态',
    type: ModelModalitiesDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ModelModalitiesDto)
  modalities?: ModelModalitiesDto;

  @ApiPropertyOptional({
    description:
      '透传给 provider SDK 的选项（如 reasoningEffort）——思考强度只能经此配置',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}
