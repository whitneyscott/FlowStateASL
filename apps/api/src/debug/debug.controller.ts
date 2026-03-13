import { Controller, Get, Query } from '@nestjs/common';
import { getLastError, getLtiLog, clearLtiLog } from '../common/last-error.store';

@Controller('debug')
export class DebugController {
  @Get('last-error')
  getLastError() {
    try {
      const data = getLastError();
      return data ?? null;
    } catch (err) {
      console.error('[DebugController] getLastError failed:', err);
      return null;
    }
  }

  @Get('lti-log')
  getLtiLog(@Query('clear') clear?: string) {
    try {
      if (clear === '1' || clear === 'true') clearLtiLog();
      const lines = getLtiLog();
      return { lines: Array.isArray(lines) ? lines : [] };
    } catch (err) {
      console.error('[DebugController] getLtiLog failed:', err);
      return { lines: [] };
    }
  }
}
