import { Module } from '@nestjs/common';
import { CanvasService } from './canvas.service';

@Module({
  providers: [CanvasService],
  exports: [CanvasService],
})
export class CanvasModule {}
