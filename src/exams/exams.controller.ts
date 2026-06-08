import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { PublicUser } from '../users/users.service';
import { ExamsService } from './exams.service';
import { CreateExamDto, UpdateExamDto } from './dto/exam.dto';
import { QuestionDto } from '../tickets/dto/question.dto';
import type { UploadedDocx } from './docx-parser';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

class AddTicketDto {
  @IsOptional() @IsString() title?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => QuestionDto) questions!: QuestionDto[];
}

@ApiTags('exams')
@ApiBearerAuth('jwt')
@Controller()
@UseGuards(JwtAuthGuard)
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Get('exams')
  @ApiOperation({ summary: 'List exams (filter by subject/status/query)' })
  @ApiQuery({ name: 'subjectId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['Черновик', 'Опубликован', 'Запланирован', 'Архив'] })
  @ApiQuery({ name: 'q', required: false, type: String })
  list(
    @CurrentUser() user: PublicUser,
    @Query('subjectId') subjectId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.exams.listForTeacher(user.id, { subjectId, status, q });
  }

  @Get('subjects/:id/exams')
  @ApiOperation({ summary: 'List exams for a specific subject' })
  listForSubject(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.listForSubject(user.id, id);
  }

  @Post('exams')
  @ApiOperation({ summary: 'Create exam + its first ticket atomically' })
  create(@CurrentUser() user: PublicUser, @Body() dto: CreateExamDto) {
    return this.exams.create(user.id, dto);
  }

  @Post('exams/parse-docx')
  @ApiOperation({
    summary:
      'Parse an uploaded .docx into exam tickets + verbal questions (no persistence). ' +
      'Each "N-variant" line becomes a ticket; each bullet under it becomes a question.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  parseDocx(@CurrentUser() _user: PublicUser, @UploadedFile() file: UploadedDocx) {
    return this.exams.parseDocx(file);
  }

  @Get('exams/:id')
  @ApiOperation({ summary: 'Get one exam with its tickets + their questions' })
  getOne(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.getOne(user.id, id);
  }

  @Patch('exams/:id')
  @ApiOperation({ summary: 'Update exam metadata' })
  update(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExamDto,
  ) {
    return this.exams.update(user.id, id, dto);
  }

  @Post('exams/:id/publish')
  @ApiOperation({ summary: 'Transition exam status → Опубликован' })
  publish(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.publish(user.id, id);
  }

  @Post('exams/:id/share')
  @ApiOperation({
    summary: 'Get the shareable join URL: reuses an existing scheduled/live session or creates one.',
  })
  share(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.findOrCreateShareSession(user.id, id);
  }

  @Post('exams/:id/launch')
  @ApiOperation({
    summary:
      'Reuse-or-create a session, mark it live, broadcast session:start with random ticket per member.',
  })
  launch(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.launch(user.id, id);
  }

  @Delete('exams/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete exam (cascades to tickets/questions/sessions)' })
  async remove(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.exams.remove(user.id, id);
  }

  @Post('exams/:id/tickets')
  @ApiOperation({ summary: 'Append a new ticket to an exam' })
  addTicket(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddTicketDto,
  ) {
    return this.exams.addTicket(user.id, id, body);
  }
}
