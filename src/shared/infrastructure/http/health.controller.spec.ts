import { EntityManager } from '@mikro-orm/core';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from './health.controller.js';
import { SqsMessagingService } from '../messaging/sqs-messaging.service.js';

describe('HealthController', () => {
  const execute = vi.fn();
  const checkReadiness = vi.fn();
  let app: Awaited<ReturnType<typeof createApp>>;

  async function createApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule.forRoot()],
      controllers: [HealthController],
      providers: [
        {
          provide: EntityManager,
          useValue: { getConnection: () => ({ execute }) },
        },
        {
          provide: SqsMessagingService,
          useValue: { checkReadiness },
        },
      ],
    }).compile();
    const application = moduleRef.createNestApplication();
    await application.init();
    return application;
  }

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(undefined);
    checkReadiness.mockReset().mockResolvedValue(undefined);
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 when PostgreSQL and SQS are ready', async () => {
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
        expect(body.details).toMatchObject({
          database: { status: 'up' },
          sqs: { status: 'up' },
        });
      });
  });

  it('returns 503 with dependency status when PostgreSQL is unavailable', async () => {
    execute.mockRejectedValue(new Error('database connection failed'));

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect(({ body }) => {
        expect(body.status).toBe('error');
        expect(body.error.database).toMatchObject({
          status: 'down',
          message: 'PostgreSQL is unavailable',
        });
      });
  });
});
