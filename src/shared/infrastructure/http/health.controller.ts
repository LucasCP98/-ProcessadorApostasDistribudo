import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { EntityManager } from '@mikro-orm/core';
import { SqsMessagingService } from '../messaging/sqs-messaging.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly em: EntityManager,
    private readonly messaging: SqsMessagingService,
  ) {}

  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([async () => ({ application: { status: 'up' } })]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => {
        await this.em.getConnection().execute('select 1');
        return { database: { status: 'up' } };
      },
      async () => {
        await this.messaging.checkReadiness();
        return { sqs: { status: 'up' } };
      },
    ]);
  }
}
