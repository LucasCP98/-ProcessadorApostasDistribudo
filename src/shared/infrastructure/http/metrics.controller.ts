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

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', register.contentType)
  async metrics(): Promise<string> {
    return register.metrics();
  }
}
