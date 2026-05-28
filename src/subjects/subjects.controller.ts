import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { PublicUser } from '../users/users.service';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

@ApiTags('subjects')
@ApiBearerAuth('jwt')
@Controller('subjects')
@UseGuards(JwtAuthGuard)
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List subjects owned by the current teacher (with derived counts)' })
  list(@CurrentUser() user: PublicUser) {
    return this.subjects.listForTeacher(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a subject' })
  create(@CurrentUser() user: PublicUser, @Body() dto: CreateSubjectDto) {
    return this.subjects.create(user.id, dto);
  }

  @Post('mock')
  @ApiOperation({ summary: 'Seed a demo subject + exam + 3 tickets + sample questions' })
  createMock(@CurrentUser() user: PublicUser) {
    return this.subjects.createMock(user.id);
  }

  @Delete('mock')
  @ApiOperation({ summary: 'Remove all DEMO-* subjects (cascades exams/tickets/questions/sessions)' })
  removeMock(@CurrentUser() user: PublicUser) {
    return this.subjects.removeMock(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one subject (with counts)' })
  getOne(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.subjects.getOne(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update subject metadata' })
  update(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubjectDto,
  ) {
    return this.subjects.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete subject (cascades to tickets/questions/sessions)' })
  async remove(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.subjects.remove(user.id, id);
  }
}
