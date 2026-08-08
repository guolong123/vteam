import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { AdminGuard } from './admin.guard';

@Module({
  controllers: [UsersController, RolesController],
  providers: [UsersService, RolesService, AdminGuard],
})
export class UsersModule {}
