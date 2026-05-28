import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SubjectsModule } from './subjects/subjects.module';
import { TicketsModule } from './tickets/tickets.module';
import { ExamsModule } from './exams/exams.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    SubjectsModule,
    TicketsModule,
    ExamsModule,
    SessionsModule,
  ],
})
export class AppModule {}
