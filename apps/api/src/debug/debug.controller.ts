import { Controller, Get, Query } from '@nestjs/common';
import { getLastError, getLtiLog, clearLtiLog } from '../common/last-error.store';

@Controller('debug')
export class DebugController {
  @Get('last-error')
  getLastError() {
    return getLastError();
  }

  @Get('lti-log')
  getLtiLog(@Query('clear') clear?: string) {
    if (clear === '1' || clear === 'true') clearLtiLog();
    return { lines: getLtiLog() };
  }
}
