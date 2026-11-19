import { Module } from '@nestjs/common';
import { SqsMessagingService } from './sqs-messaging.service.js';

@Module({
  providers: [SqsMessagingService],
  exports: [SqsMessagingService],
})
export class MessagingModule {}
