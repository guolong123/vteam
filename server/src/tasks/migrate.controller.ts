import { Controller, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('migrate')
export class MigrateController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('add-enabled')
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
