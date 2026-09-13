import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';

/**
 * PATCH /agents/omo-config 请求体：OmO 的 agent→模型覆盖（增量合并）。
 *
 * `agents` 是 `{ <omo agent 名>: "<providerID>/<modelID>" }`：
 * - 只提交要改的 agent，未提交的保持原样；
 * - 值传空串 = 删除该 agent 的覆盖（回落 OmO 默认）；
 * - OmO 可配的 agent 名来自其包内 schema（worker `GET /omo-config` 的 `available`
 *   字段会列出），此处不硬编码白名单——避免 OmO 升级后 vteam 把新 agent 挡在门外。
 */
export class UpdateOmoConfigDto {
  @ApiProperty({
    description: 'agent 名 → 模型（providerID/modelID）；空串表示清除该覆盖',
    example: { sisyphus: 'opencode/big-pickle', prometheus: 'opencode/big-pickle' },
  })
  @IsObject()
  agents!: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'OmO 插件开关：true=serve 启动时加载 OmO（可配 agent 模型）；false=不加载（等价 --pure，省 token）。不传=不改动。',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
