import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './shared/infrastructure/http/health.controller.js';
import {
  HttpMetricsInterceptor,
  MetricsController,
} from './shared/infrastructure/http/metrics.controller.js';
import { WageringModule } from './wagering/wagering.module.js';
import { databaseOptions } from './shared/infrastructure/database/database.config.js';
import { MessagingModule } from './shared/infrastructure/messaging/messaging.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(databaseOptions),
    TerminusModule.forRoot(),
    MessagingModule,
    WageringModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [HttpMetricsInterceptor],
})
export class AppModule {}