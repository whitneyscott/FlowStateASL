import { Module } from '@nestjs/common';
import { CanvasService } from './canvas.service';
import { CanvasOAuthController } from './canvas-oauth.controller';

@Module({
  controllers: [CanvasOAuthController],
  providers: [CanvasService],
  exports: [CanvasService],
})
export class CanvasModule {}
