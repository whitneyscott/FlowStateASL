import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { join } from 'path';
import { renderDebugPage } from './debug-page';

@Catch()
export class DebugExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (req.path.startsWith('/api')) {
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
      const message =
        exception instanceof Error ? exception.message : String(exception);
      if (!res.headersSent) {
        res.status(status).json({ message, error: 'Internal Server Error' });
      }
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof Error ? exception.message : String(exception);

    const webRoot = join(__dirname, '..', '..', '..', 'web');
    const exactDirectoryLookedIn = join(webRoot, req.path);

    const html = renderDebugPage({
      statusCode: status,
      error: message,
      handler: 'DebugExceptionFilter',
      request_path: req.path,
      request_method: req.method,
      request_url: req.originalUrl || req.url,
      exact_directory_looked_in: exactDirectoryLookedIn,
      static_root_path: webRoot,
      __dirname,
    });

    res.setHeader('Content-Type', 'text/html').status(status).send(html);
  }
}
