import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { PublicUser } from '../users/users.service';
import { TicketsService } from './tickets.service';
import { UpdateTicketDto } from './dto/question.dto';

@ApiTags('tickets')
@ApiBearerAuth('jwt')
@Controller()
@UseGuards(JwtAuthGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('tickets/:id')
  @ApiOperation({ summary: 'Get one ticket with its questions + parent exam metadata' })
  getOne(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.getOne(user.id, id);
  }

  @Patch('tickets/:id')
  @ApiOperation({ summary: 'Update ticket title and/or replace questions' })
  update(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.tickets.update(user.id, id, dto);
  }

  @Delete('tickets/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete ticket (cascades to questions/answers)' })
  async remove(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.tickets.remove(user.id, id);
  }
}
