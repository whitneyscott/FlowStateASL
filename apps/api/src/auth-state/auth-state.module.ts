import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { AuthSessionService } from './auth-session.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuthSessionEntity])],
  providers: [AuthSessionService],
  exports: [AuthSessionService, TypeOrmModule],
})
export class AuthStateModule {}
