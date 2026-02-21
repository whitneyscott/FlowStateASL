import { Controller, Get } from '@nestjs/common';
import { getLastError } from '../common/last-error.store';

@Controller('debug')
export class DebugController {
  @Get('last-error')
  getLastError() {
    return getLastError();
  }
}
