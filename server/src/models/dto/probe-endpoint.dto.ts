import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /models/probe-endpoint 请求体（C8：自动探测预填）。
 * baseUrl 为 OpenAI 兼容根（与 CreateModelDto.baseUrl 同规则）——
 * server 请求 `{baseUrl}/models` 读 vLLM/OpenAI 风格的模型列表以预填上下文长度。
 */
export class ProbeEndpointDto {
  @ApiProperty({
    description: 'OpenAI 兼容根（http(s) URL）',
    example: 'http://192.168.10.10:18020/v1',
    maxLength: 512,
  })
  @IsString()
  @MaxLength(512)
  @Matches(/^https?:\/\/.+/, { message: 'baseUrl 需为 http(s) URL' })
  baseUrl!: string;
}
