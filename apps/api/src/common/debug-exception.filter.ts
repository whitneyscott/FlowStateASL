import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { join } from 'path';
import { appendLtiLog, setLastError } from './last-error.store';
import { renderDebugPage } from './debug-page';

function isDatabaseUnavailableError(exception: unknown, message: string): boolean {
  const m = message.toLowerCase();
  if (
    m.includes('database system is shutting down') ||
    m.includes('terminating connection') ||
    m.includes('too many connections') ||
    m.includes('connection terminated unexpectedly') ||
    m.includes('connection refused') ||
    m.includes('read econnreset')
  ) {
    return true;
  }
  const code = (exception as { code?: string; driverError?: { code?: string } })?.code
    ?? (exception as { driverError?: { code?: string } })?.driverError?.code;
  return ['57P01', '57P02', '53300', '08006', '08001'].includes(String(code ?? ''));
}

@Catch()
export class DebugExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (req.path.startsWith('/api')) {
      let status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
      const rawMessage =
        exception instanceof Error ? exception.message : String(exception);
      const dbUnavailable = isDatabaseUnavailableError(exception, rawMessage);
      if (dbUnavailable) status = HttpStatus.SERVICE_UNAVAILABLE;
      const message = dbUnavailable
        ? 'Server temporarily unavailable, please try again shortly.'
        : rawMessage;
      setLastError(`${req.method} ${req.path}`, exception);
      appendLtiLog('api-error', `${req.method} ${req.path}`, {
        message,
        status,
        dbUnavailable,
        rawMessage,
      });
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
