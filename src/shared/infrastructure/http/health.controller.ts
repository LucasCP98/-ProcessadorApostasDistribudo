import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { EntityManager } from '@mikro-orm/core';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SqsMessagingService } from '../messaging/sqs-messaging.service.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly em: EntityManager,
    private readonly messaging: SqsMessagingService,
  ) {}

  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: 'Check process liveness' })
  @ApiResponse({ status: 200, description: 'Application is live.' })
  liveness() {
    return this.health.check([async () => ({ application: { status: 'up' } })]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Check PostgreSQL and SQS readiness' })
  @ApiResponse({
    status: 200,
    description: 'Application dependencies are ready.',
  })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is unavailable.',
  })
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
