import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  httpRequestDuration,
  httpRequests,
  register,
} from '../observability/metrics-registry.js';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const route = request.route?.path ?? request.path;
    const endTimer = httpRequestDuration.startTimer({
      method: request.method,
      route,
    });

    return next.handle().pipe(
      finalize(() => {
        httpRequests
          .labels(request.method, route, String(response.statusCode))
          .inc();
        endTimer();
      }),
    );
  }
}

@ApiTags('Observability')
@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', register.contentType)
  @ApiOperation({ summary: 'Expose Prometheus metrics' })
  @ApiResponse({
    status: 200,
    description: 'Prometheus text metrics.',
    content: {
      'text/plain': {
        schema: { type: 'string' },
      },
    },
  })
  async metrics(): Promise<string> {
    return register.metrics();
  }
}
