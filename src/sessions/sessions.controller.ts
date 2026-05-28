import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentMember } from '../auth/decorators/current-member.decorator';
import { SessionTokenGuard, SESSION_TOKEN_COOKIE } from '../auth/guards/session-token.guard';
import type { PublicUser } from '../users/users.service';
import { SessionsService } from './sessions.service';
import {
  CreateSessionDto,
  GradeDto,
  JoinSessionDto,
  SubmitAnswersDto,
  VerbalActionDto,
} from './dto/session.dto';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // ── Teacher ──
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: '[teacher] Create a session for a ticket' })
  create(@CurrentUser() user: PublicUser, @Body() dto: CreateSessionDto) {
    return this.sessions.create(user.id, dto);
  }

  @Get('upcoming')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: "[teacher] Upcoming sessions (live + scheduled)" })
  listUpcoming(@CurrentUser() user: PublicUser) {
    return this.sessions.listUpcoming(user.id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: '[teacher] Session meta + ticket info' })
  getOne(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.getOne(user.id, id);
  }

  @Get(':id/roster')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: '[teacher] Roster of room members' })
  getRoster(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.getRoster(user.id, id);
  }

  @Post(':id/start')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: '[teacher] Start session — assigns tickets, broadcasts `session:start`' })
  start(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.start(user.id, id);
  }

  @Post(':id/end')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: '[teacher] End session — broadcasts `session:end`' })
  end(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.end(user.id, id);
  }

  // ── Student ──
  @Post(':id/members')
  @ApiOperation({
    summary: '[student] Join session (anon) — sets `ticketer_session` cookie; same name+group rejoins',
  })
  async join(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: JoinSessionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sessionToken, member } = await this.sessions.join(id, dto);
    res.cookie(SESSION_TOKEN_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return { memberId: member.id, sessionToken, member };
  }

  @Get(':id/me')
  @UseGuards(SessionTokenGuard)
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: '[student] Get my member + assigned ticket (teacher-only fields stripped)',
  })
  getMe(@Param('id', ParseUUIDPipe) id: string, @CurrentMember() member: any) {
    return this.sessions.getMe(id, member.id);
  }

  @Post(':id/answers')
  @UseGuards(SessionTokenGuard)
  @ApiCookieAuth('session')
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Submit/upsert MCQ/text/numeric answers in batch' })
  submitAnswers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMember() member: any,
    @Body() dto: SubmitAnswersDto,
  ) {
    return this.sessions.submitAnswers(id, member.id, dto);
  }

  // ── Proctor ──
  @Post(':id/verbal/start')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(204)
  @ApiOperation({
    summary: '[proctor] Mark verbal recording started — broadcasts `verbal:status: recording`',
  })
  async verbalStart(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerbalActionDto,
  ) {
    await this.sessions.verbalStart(user.id, id, dto);
  }

  @Post(':id/verbal/stop')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(204)
  @ApiOperation({
    summary: '[proctor] Mark verbal recording stopped — broadcasts `verbal:status: finished`',
  })
  async verbalStop(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerbalActionDto,
  ) {
    await this.sessions.verbalStop(user.id, id, dto);
  }

  @Post(':id/grade')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(204)
  @ApiOperation({ summary: '[proctor] Save verbal grade — broadcasts `grade:save`' })
  async grade(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GradeDto,
  ) {
    await this.sessions.grade(user.id, id, dto);
  }
}
