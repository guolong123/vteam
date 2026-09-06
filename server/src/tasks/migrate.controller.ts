import { Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('migrate')
@Controller('migrate')
export class MigrateController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('add-enabled')
  @ApiOperation({ summary: '一次性迁移：补任务实例启用列（已存在则幂等返回）' })
  async addEnabled() {
    try {
      await this.prisma.$executeRawUnsafe(
        `ALTER TABLE task_agents ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT true`,
      );
      return { ok: true };
    } catch (e: any) {
      if (String(e.message).includes('Duplicate column'))
        return { ok: true, existed: true };
      throw e;
    }
  }
}
