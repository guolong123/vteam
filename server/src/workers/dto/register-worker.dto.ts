import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** worker 能力声明（对齐 schema Worker.capabilities Json，T1 契约基座）。 */
export class WorkerCapabilitiesDto {
  @ApiProperty({ description: '最大可承载并发会话实例数' })
  @IsInt()
  @Min(0)
  maxInstances: number;

  @ApiProperty({ description: 'worker 启用的 skill 名列表', type: [String] })
  @IsArray()
  @IsString({ each: true })
  skills: string[];

  @ApiProperty({ description: 'worker 暴露的工具名列表', type: [String] })
  @IsArray()
  @IsString({ each: true })
  tools: string[];

  @ApiPropertyOptional({ description: 'serve 实际监听端口（F2 C2：随机端口上报，供 WorkerClient.resolveBaseUrl 直连）' })
  @IsOptional()
  @IsInt()
  @Min(0)
  port?: number;

  @ApiPropertyOptional({ description: 'serve 对 server 公布的基址（D2：WORKER_ADVERTISE_HOST:port，容器内 http://worker:port；resolveBaseUrl 优先读取）' })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'C2：serve 实际可用模型 id 列表（listModels 上报，id 格式 providerID/modelID；失败缺省，C3 合并入库用）', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional({ description: 'T10：worker 执行端点端口（方案 A POST /execute；server 据此发现执行端点下发 prompt，缺省回退 serve origin + 4198）' })
  @IsOptional()
  @IsInt()
  @Min(0)
  execPort?: number;
}

/** worker 负载快照（对齐 schema Worker.load Json）。 */
export class WorkerLoadDto {
  @ApiProperty({ description: '当前并发会话实例数' })
  @IsInt()
  @Min(0)
  instances: number;
}

/**
 * POST /workers/register 请求体（架构决策 D1：全 push 三通道之注册，X-Worker-Token 鉴权）。
 * workerId 为部署配置的全局唯一 id（w_ 前缀），opencodeVersion 供 server 版本兼容判断。
 */
export class RegisterWorkerDto {
  @ApiProperty({ description: '部署配置的全局唯一 id（w_ 前缀）' })
  @IsString()
  @IsNotEmpty()
  workerId: string;

  @ApiPropertyOptional({ description: 'worker 显示名（可选）' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'opencode 版本号（serve --version）' })
  @IsString()
  @IsNotEmpty()
  opencodeVersion: string;

  @ApiProperty({ description: 'worker 能力声明', type: WorkerCapabilitiesDto })
  @IsObject()
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => WorkerCapabilitiesDto)
  capabilities: WorkerCapabilitiesDto;

  @ApiProperty({ description: '注册时负载快照', type: WorkerLoadDto })
  @IsObject()
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => WorkerLoadDto)
  load: WorkerLoadDto;

  @ApiPropertyOptional({ description: 'C2：worker 配置的默认模型（env WORKER_DEFAULT_MODEL，id 格式 providerID/modelID，C7 分派兜底）' })
  @IsOptional()
  @IsString()
  defaultModelId?: string;

  @ApiPropertyOptional({ description: '内置 vteam MCP 地址覆盖（env WORKER_MCP_URL；集群外 worker 用它覆盖 seed 的 PLATFORM_MCP_URL）' })
  @IsOptional()
  @IsString()
  mcpUrl?: string;
}
