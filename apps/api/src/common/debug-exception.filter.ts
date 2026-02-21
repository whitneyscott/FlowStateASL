import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { renderDebugPage } from './debug-page';

/**
 * Catches 404 and other exceptions, serves an HTML debug page instead of JSON.
 * Like PHP echo - shows request path, error, etc. on the page for troubleshooting LTI.
 */
@Catch()
export class DebugExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // For API routes, preserve JSON responses (React/axios expect JSON)
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

    const html = renderDebugPage({
      statusCode: status,
      error: message,
      request_path: req.path,
      request_method: req.method,
      request_url: req.originalUrl || req.url,
      hint:
        status === 404
          ? '404 = route not found. For /flashcards, SpaMiddleware should serve index.html. If you see this, the request may not be reaching SpaMiddleware.'
          : 'Check the error and request details above.',
    });

    res.setHeader('Content-Type', 'text/html').status(status).send(html);
  }
}
