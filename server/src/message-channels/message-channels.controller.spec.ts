import { Test } from '@nestjs/testing';
import { MessageChannelsController } from './message-channels.controller';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { MessageRegistryService } from './message-registry.service';
import { MessageDeliveryService } from './message-delivery.service';
import { MessageInboundService } from './message-inbound.service';

describe('MessageChannelsController', () => {
  let controller: MessageChannelsController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [MessageChannelsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            messageChannel: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            messageDelivery: { findMany: jest.fn() },
            taskMessageChannel: { findMany: jest.fn() },
            task: { findUnique: jest.fn() },
          },
        },
        IdGeneratorService,
        {
          provide: MessageRegistryService,
          useValue: {
            get: jest.fn(),
            getChannel: jest.fn(),
            requestStop: jest.fn(),
            startEnabled: jest.fn(),
            submitInbound: jest.fn(),
          },
        },
        {
          provide: MessageDeliveryService,
          useValue: { listByChannel: jest.fn() },
        },
        { provide: MessageInboundService, useValue: {} },
      ],
    }).compile();
    controller = module.get(MessageChannelsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('inbound route is Public (no auth guard)', async () => {
    const { IS_PUBLIC_KEY } =
      await import('../auth/decorators/public.decorator');
    const handler = (controller as any).inbound;
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler);
    expect(isPublic).toBe(true);
  });
});
