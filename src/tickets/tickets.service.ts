import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Transaction } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/schema';
import type { QuestionDto, UpdateTicketDto } from './dto/question.dto';

@Injectable()
export class TicketsService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  // ───────────── Read ─────────────
  async getOne(teacherId: string, id: string) {
    const ticket = await this.db
      .selectFrom('tickets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.authorId !== teacherId) throw new ForbiddenException();

    const exam = await this.db
      .selectFrom('exams')
      .selectAll()
      .where('id', '=', ticket.examId)
      .executeTakeFirstOrThrow();

    const questions = await this.db
      .selectFrom('questions')
      .selectAll()
      .where('ticketId', '=', id)
      .orderBy('position')
      .execute();

    return {
      ...ticket,
      exam,
      questions: questions.map((q) => this.deserializeQuestion(q)),
    };
  }

  // ───────────── Update ─────────────
  async update(teacherId: string, id: string, dto: UpdateTicketDto) {
    const existing = await this.db
      .selectFrom('tickets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException();
    if (existing.authorId !== teacherId) throw new ForbiddenException();

    return this.db.transaction().execute(async (trx) => {
      if (dto.title !== undefined) {
        await trx
          .updateTable('tickets')
          .set({ title: dto.title, updatedAt: new Date() })
          .where('id', '=', id)
          .execute();
      }
      if (dto.questions) {
        await trx.deleteFrom('questions').where('ticketId', '=', id).execute();
        await this.insertQuestions(trx, id, dto.questions);
      }
      return this.getOneWithTrx(trx, id);
    });
  }

  // ───────────── Delete ─────────────
  async remove(teacherId: string, id: string): Promise<void> {
    const existing = await this.db
      .selectFrom('tickets')
      .select('authorId')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException();
    if (existing.authorId !== teacherId) throw new ForbiddenException();
    await this.db.deleteFrom('tickets').where('id', '=', id).execute();
  }

  // ───────────── Helpers ─────────────
  private async insertQuestions(
    trx: Transaction<DB>,
    ticketId: string,
    questions: QuestionDto[],
  ): Promise<void> {
    const rows = questions.map((q, idx) => ({
      ticketId,
      position: idx,
      type: q.type,
      text: q.text,
      points: q.points,
      timeSec: q.time,
      difficulty: q.difficulty,
      payload: JSON.stringify(this.extractPayload(q)),
    }));
    if (rows.length === 0) return;
    await trx.insertInto('questions').values(rows as any).execute();
  }

  private extractPayload(q: QuestionDto): Record<string, unknown> {
    switch (q.type) {
      case 'single':
        return { answers: q.answers ?? [], correct: typeof q.correct === 'number' ? q.correct : 0 };
      case 'multi':
        return { answers: q.answers ?? [], correct: Array.isArray(q.correct) ? q.correct : [] };
      case 'text':
        return { expected: q.expected ?? '' };
      case 'numeric':
        return { expected: q.expected ?? 0, tolerance: q.tolerance ?? 0 };
      case 'verbal':
        return { rubric: q.rubric ?? '' };
    }
  }

  private deserializeQuestion(row: any) {
    const payload = row.payload ?? {};
    return {
      id: row.id,
      type: row.type,
      text: row.text,
      points: row.points,
      time: row.timeSec,
      difficulty: row.difficulty,
      position: row.position,
      ...payload,
    };
  }

  private async getOneWithTrx(trx: Transaction<DB>, id: string) {
    const ticket = await trx.selectFrom('tickets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const questions = await trx.selectFrom('questions').selectAll().where('ticketId', '=', id).orderBy('position').execute();
    return { ...ticket, questions: questions.map((q) => this.deserializeQuestion(q)) };
  }
}
