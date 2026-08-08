import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get()
  @ApiOperation({ summary: '健康检查' })
  @HealthCheck()
  check() {
    // 基础存活检查：返回 {"status":"ok"}
    return this.health.check([]);
  }
}
