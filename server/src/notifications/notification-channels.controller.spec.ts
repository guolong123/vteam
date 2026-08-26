import { Test } from '@nestjs/testing';
import { NotificationChannelsController } from './notification-channels.controller';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { NotificationRegistryService } from './notification-registry.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';

describe('NotificationChannelsController', () => {
  let controller: NotificationChannelsController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [NotificationChannelsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            notificationChannel: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            notificationDelivery: { findMany: jest.fn() },
            taskNotificationChannel: { findMany: jest.fn() },
            task: { findUnique: jest.fn() },
          },
        },
        IdGeneratorService,
        {
          provide: NotificationRegistryService,
          useValue: { get: jest.fn(), startEnabled: jest.fn() },
        },
        {
          provide: NotificationDeliveryService,
          useValue: { listByChannel: jest.fn() },
        },
        {
          provide: NotificationDispatcherService,
          useValue: { dispatchToChannel: jest.fn() },
        },
      ],
    }).compile();
    controller = module.get(NotificationChannelsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
