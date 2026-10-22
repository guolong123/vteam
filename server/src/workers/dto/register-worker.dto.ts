import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  WORKER_UPDATE_STATES,
  WorkerUpdateState,
} from '../worker-update-state';

/** worker agent 策略能力位（Todo 14：injector 注入结果透传；旧 worker 缺省=不支持）。 */
export class WorkerAgentPoliciesDto {
  @ApiProperty({
    description:
      'agent 策略**本轮**是否刷新成功（成功写入 agent 节=true；本轮未刷新=拉取失败/形状非法/角色集为空=false）。' +
      '⚠️ false **不等于**「没有受管块」——批次 D-1 起中性化路径改为**保留**上次受管块。',
  })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({
    description:
      'agent 名清单。**语义随 stale 变**：stale 缺席/false = 本轮写入 opencode.json 的 agent 节的名；' +
      'stale=true = **上次已知**的名（受管块仍保留在 worker 本地、内容未改写；从未成功注入过则为空数组）。',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  names: string[];

  @ApiPropertyOptional({
    description:
      'true = 本轮**未刷新** agent 策略，且受管块**保留在 worker 本地**（批次 D-2）。' +
      '此时 names 是「上次已知」清单：能力位门据此**放行**点名（该轮跑在**上次已知**的角色权限集上，' +
      '既不收窄也不放大）——批次 D 的「陈旧即不派发」并不成立（派发照旧发生，丢的是 agent 名 ⇒ ' +
      '退回引擎默认 agent ⇒ 角色 permissions[] 失效 ⇒ 权限放大）。缺席/false = 本轮新鲜。',
  })
  @IsOptional()
  @IsBoolean()
  stale?: boolean;

  @ApiPropertyOptional({ description: '能力位生成时间（ISO 8601，可选）' })
  @IsOptional()
  @IsString()
  generatedAt?: string;
}

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

  @ApiPropertyOptional({
    description:
      'serve 实际监听端口（F2 C2：随机端口上报；**v2 控制面不直连 serve**，该端口不参与拨号——控制面只用 baseUrl 的主机部分 + capabilities.execPort 拼执行端点）',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  port?: number;

  @ApiPropertyOptional({
    description:
      'worker 对控制面公布的基址（D2：WORKER_ADVERTISE_HOST:port，容器内 http://worker:port；**控制面只取其中的主机部分**——serve 端口不再被使用，执行端点端口取 capabilities.execPort）',
  })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({
    description:
      'C2：serve 实际可用模型 id 列表（listModels 上报，id 格式 providerID/modelID；失败缺省，C3 合并入库用）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional({
    description:
      'models-truth：worker 可执行模型 id 列表（**worker 自己 serve 的 `GET /api/model`** —— v2 下 `opencode models` CLI 绑的是共享后台服务、读的是另一个作用域，不能用作真值源；缺省时 sync 回退 worker 执行端点的模型目录）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  executableModels?: string[];

  @ApiPropertyOptional({
    description:
      'T10：worker 执行端点端口（方案 A POST /execute；server 据此发现执行端点下发 prompt，缺省回退「上报 baseUrl 的主机部分 + 默认执行端口 4198」——**控制面不使用 serve 端口**）',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  execPort?: number;

  @ApiPropertyOptional({
    description:
      'Todo 14：agent 策略能力位（injector 注入结果透传；旧 worker 缺省=不支持，whitelist 下须显式声明否则被剔除）',
    type: WorkerAgentPoliciesDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => WorkerAgentPoliciesDto)
  agentPolicies?: WorkerAgentPoliciesDto;
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

  @ApiPropertyOptional({
    description:
      'C2：worker 配置的默认模型（env WORKER_DEFAULT_MODEL，id 格式 providerID/modelID，C7 分派兜底）',
  })
  @IsOptional()
  @IsString()
  defaultModelId?: string;

  @ApiPropertyOptional({
    description:
      '内置 vteam MCP 地址覆盖（env WORKER_MCP_URL；集群外 worker 用它覆盖 seed 的 PLATFORM_MCP_URL）',
  })
  @IsOptional()
  @IsString()
  mcpUrl?: string;

  /**
   * worker 代码版本（worker-self-update Todo 2）：pack-worker 构建期戳的
   * git 短 SHA / `manual-<date>` / `dev`。旧 worker 不携带该字段——**可选，
   * 缺席不报错、不清空已有值**（持久化语义见 workers.service.ts register）。
   */
  @ApiPropertyOptional({
    description:
      'worker 代码版本（git 短 SHA / manual-<date> / dev）；旧 worker 缺省 = 版本未知',
  })
  @IsOptional()
  @IsString()
  codeVersion?: string;

  /**
   * 自更新执行状态（worker-self-update Todo 3 ↔ Todo 4 共享契约，**字段名逐字对齐**）。
   * worker 更新执行器当前状态（pending/downloading/restarting/ready-manual/rolledback）；
   * server 只透传 + 落库 + 供 UI 展示，不发明状态、不做状态机推断。
   * 旧 worker 不携带——**可选，缺席不清空已有值**（持久化语义见 workers.service.ts register）。
   */
  @ApiPropertyOptional({
    description:
      '自更新执行状态（pending/downloading/restarting/ready-manual/rolledback）；旧 worker 缺省 = 未上报',
    enum: Object.values(WORKER_UPDATE_STATES),
  })
  @IsOptional()
  @IsIn(Object.values(WORKER_UPDATE_STATES))
  updateState?: WorkerUpdateState;

  /**
   * 最近一次自更新是否已被自动回滚（一次性结果标志，可保持为 true 供 UI 展示）。
   * 缺席（undefined）= 「本次没上报」→ 不写列；显式 false 才落 false。
   */
  @ApiPropertyOptional({
    description:
      '最近一次自更新是否已被自动回滚（缺席 = 未上报，不覆盖已有值）',
  })
  @IsOptional()
  @IsBoolean()
  rolledBack?: boolean;
}
