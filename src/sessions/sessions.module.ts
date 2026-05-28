import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionsGateway } from './sessions.gateway';

@Module({
  imports: [AuthModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionsGateway],
  exports: [SessionsService],
})
export class SessionsModule {}
