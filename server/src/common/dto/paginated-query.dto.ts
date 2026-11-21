/**
 * 列表查询参数的公共分页字段（`page` / `pageSize`）。
 *
 * 为什么用基类而不是装饰器工厂：课题是 **Swagger 文档必须逐字段不变**。
 * `class-validator` / `@nestjs/swagger` 的元数据都挂在 prototype 上且会被子类继承，
 * 因此把两个字段原样搬进基类后，每个 DTO 生成的 OpenAPI schema 与校验规则完全一致
 * （改动前后用 `Reflect` 元数据快照逐字段比对过）。
 *
 * 此前 `page` / `pageSize` 的装饰器块在 14 个 Query DTO 里逐字复制，且**文案已经漂移**
 * （「每页条数」/「每页条数（上限 100）」/「每页条数（1..100）」/「每页条数（1-100）」）——
 * 同一字段在 API 文档里有四种说法。现在只有本文件一处。
 *
 * 口径：`page` 缺省 1、从 1 起；`pageSize` 缺省 20、服务端上限 100
 * （`common/pagination.ts` 是运行时归一化的唯一实现，本 DTO 只做入参校验）。
 *
 * 极少数端点有**不同的契约默认值**（如外部用户列表按契约默认 50）——
 * 这类差异用 `createPaginatedQueryDto` 生成专用基类，而不是在端点里再手抄一遍字段。
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** 列表查询分页字段（各 `Query*Dto extends` 本类即可）。 */
export class PaginatedQueryDto {
  @ApiPropertyOptional({
    description: '页码（从 1 起）',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: '每页条数（上限 100）',
    default: 20,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/** `createPaginatedQueryDto` 的入参。 */
export interface PaginatedQueryDefaults {
  /** `pageSize` 的契约默认值（进 Swagger 文档；缺省 20）。 */
  defaultPageSize?: number;
  /** `pageSize` 的契约上限（缺省不限，由 service 归一化兜到 100）。 */
  maxPageSize?: number;
}

/**
 * 生成带**端点特化默认值/上限**的分页基类。
 *
 * 仅用于契约确实与全平台缺省不同的端点（例如 `GET /external-users` 默认 50 条）。
 * 默认值/上限会同时出现在 Swagger 文档与校验规则里——与手写字段的效果完全一致。
 *
 * @param defaults - 见 {@link PaginatedQueryDefaults}
 */
export function createPaginatedQueryDto(
  defaults: PaginatedQueryDefaults = {},
): new () => PaginatedQueryDto {
  const { defaultPageSize = 20, maxPageSize } = defaults;

  class SpecializedPaginatedQueryDto extends PaginatedQueryDto {}

  // 覆盖 pageSize 的文档与校验元数据（保持与手写字段逐字段等价）。
  const sizeDecorator = ApiPropertyOptional({
    description:
      maxPageSize === undefined
        ? '每页条数（上限 100）'
        : `每页条数（1-${maxPageSize}）`,
    default: defaultPageSize,
    minimum: 1,
    ...(maxPageSize === undefined ? {} : { maximum: maxPageSize }),
  });
  sizeDecorator(SpecializedPaginatedQueryDto.prototype, 'pageSize');

  const validators: PropertyDecorator[] = [Type(() => Number), IsInt(), Min(1)];
  if (maxPageSize !== undefined) {
    validators.push(Max(maxPageSize));
  }
  for (const v of validators) {
    v(SpecializedPaginatedQueryDto.prototype, 'pageSize');
  }

  return SpecializedPaginatedQueryDto as new () => PaginatedQueryDto;
}
