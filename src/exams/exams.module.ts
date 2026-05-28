import { Module } from '@nestjs/common';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { DatabaseModule } from '../db/database.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [DatabaseModule, SessionsModule],
  controllers: [ExamsController],
  providers: [ExamsService],
  exports: [ExamsService],
})
export class ExamsModule {}
