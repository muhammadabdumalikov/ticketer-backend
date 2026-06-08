import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/schema';
import type { QuestionDto } from '../tickets/dto/question.dto';
import type { CreateExamDto, ExamTicketDto, UpdateExamDto } from './dto/exam.dto';
import { SessionsService } from '../sessions/sessions.service';
import * as mammoth from 'mammoth';
import { parseExamDocx, type ParsedDocxExam, type UploadedDocx } from './docx-parser';

export interface ExamListItem {
  id: string;
  title: string;
  status: string;
  durationMin: number;
  visibility: string;
  shuffleMode: string;
  questionCount: number;
  ticketCount: number;
  updated: string;
  author: string;
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  subjectColor: string;
  subjectSigil: string;
}

@Injectable()
export class ExamsService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly sessionsService: SessionsService,
  ) {}

  // ───────────── Launch ─────────────
  /**
   * One-click "Запустить" path: reuse a pre-shared scheduled session if any,
   * otherwise create one — then immediately call `sessions.start` so connected
   * students get the broadcast and a random ticket from the exam's pool.
   */
  async launch(teacherId: string, examId: string) {
    const share = await this.findOrCreateShareSession(teacherId, examId);
    const session = await this.sessionsService.start(teacherId, share.sessionId);
    return { sessionId: share.sessionId, status: session.status };
  }

  // ───────────── Listing ─────────────
  async listForTeacher(
    teacherId: string,
    filters: { subjectId?: string; status?: string; q?: string } = {},
  ): Promise<ExamListItem[]> {
    let q = this.db
      .selectFrom('exams as e')
      .innerJoin('subjects as s', 's.id', 'e.subjectId')
      .innerJoin('users as u', 'u.id', 'e.authorId')
      .select([
        'e.id',
        'e.title',
        'e.status',
        'e.durationMin',
        'e.visibility',
        'e.shuffleMode',
        'e.updatedAt',
        's.id as subjectId',
        's.name as subjectName',
        's.code as subjectCode',
        's.color as subjectColor',
        's.sigil as subjectSigil',
        'u.name as authorName',
        sql<number>`(
          select coalesce(sum(qc.cnt), 0)::int from (
            select count(*) as cnt
              from questions q
              join tickets t on t.id = q.ticket_id
             where t.exam_id = e.id
             group by q.ticket_id
          ) qc
        )`.as('questionCount'),
        sql<number>`(select count(*) from tickets t where t.exam_id = e.id)::int`.as('ticketCount'),
      ])
      .where('e.authorId', '=', teacherId)
      .orderBy('e.updatedAt', 'desc');

    if (filters.subjectId) q = q.where('e.subjectId', '=', filters.subjectId);
    if (filters.status) q = q.where('e.status', '=', filters.status);
    if (filters.q) {
      const like = `%${filters.q.toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql`lower(e.title)`, 'like', like),
          eb(sql`lower(s.name)`, 'like', like),
          eb(sql`lower(s.code)`, 'like', like),
        ]),
      );
    }

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      durationMin: r.durationMin,
      visibility: r.visibility,
      shuffleMode: r.shuffleMode,
      questionCount: r.questionCount,
      ticketCount: r.ticketCount,
      updated: this.relativeTime(r.updatedAt as unknown as Date),
      author: r.authorName,
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      subjectCode: r.subjectCode,
      subjectColor: r.subjectColor,
      subjectSigil: r.subjectSigil,
    }));
  }

  async listForSubject(teacherId: string, subjectId: string): Promise<ExamListItem[]> {
    return this.listForTeacher(teacherId, { subjectId });
  }

  // ───────────── Read ─────────────
  async getOne(teacherId: string, id: string) {
    const exam = await this.requireOwned(teacherId, id);
    const tickets = await this.db
      .selectFrom('tickets')
      .selectAll()
      .where('examId', '=', id)
      .orderBy('position')
      .execute();
    const ticketIds = tickets.map((t) => t.id);
    const questions = ticketIds.length
      ? await this.db
          .selectFrom('questions')
          .selectAll()
          .where('ticketId', 'in', ticketIds)
          .orderBy('position')
          .execute()
      : [];
    const byTicket = new Map<string, any[]>();
    for (const q of questions) {
      const arr = byTicket.get(q.ticketId) ?? [];
      arr.push(this.deserializeQuestion(q));
      byTicket.set(q.ticketId, arr);
    }
    return {
      ...exam,
      tickets: tickets.map((t) => ({
        id: t.id,
        title: t.title,
        position: t.position,
        questions: byTicket.get(t.id) ?? [],
      })),
    };
  }

  // ───────────── Create ─────────────
  async create(teacherId: string, dto: CreateExamDto) {
    await this.assertSubjectOwnership(teacherId, dto.subjectId);

    return this.db.transaction().execute(async (trx) => {
      const exam = await trx
        .insertInto('exams')
        .values({
          subjectId: dto.subjectId,
          authorId: teacherId,
          title: dto.details.title,
          description: dto.details.description ?? '',
          durationMin: dto.details.duration,
          attempts: dto.details.attempts ?? 1,
          visibility: dto.details.visibility ?? 'private',
          shuffleMode: dto.details.shuffle ?? 'fixed',
          status: 'Опубликован',
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await this.replaceTickets(trx, exam.id, dto.subjectId, teacherId, dto.tickets);
      // Return only the new id — the client doesn't need the full tree, and
      // re-reading hundreds of tickets/questions here just slows creation down.
      return { id: exam.id };
    });
  }

  // ───────────── Import from .docx (parse only, no persistence) ─────────────
  async parseDocx(file: UploadedDocx | undefined): Promise<ParsedDocxExam> {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('Файл не загружен.');
    }
    const name = (file.originalname ?? '').toLowerCase();
    const isDocx =
      name.endsWith('.docx') ||
      file.mimetype ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (!isDocx) {
      throw new BadRequestException('Поддерживаются только файлы .docx.');
    }
    let rawText: string;
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      rawText = result.value;
    } catch {
      throw new BadRequestException('Не удалось прочитать файл .docx.');
    }
    return parseExamDocx(rawText);
  }

  // ───────────── Update ─────────────
  async update(teacherId: string, id: string, dto: UpdateExamDto) {
    const existing = await this.requireOwned(teacherId, id);

    return this.db.transaction().execute(async (trx) => {
      if (dto.details) {
        await trx
          .updateTable('exams')
          .set({
            title: dto.details.title,
            description: dto.details.description ?? '',
            durationMin: dto.details.duration,
            attempts: dto.details.attempts ?? 1,
            visibility: dto.details.visibility ?? 'private',
            shuffleMode: dto.details.shuffle ?? 'fixed',
            updatedAt: new Date(),
          })
          .where('id', '=', id)
          .execute();
      }
      if (dto.tickets) {
        // Wipe old tickets (cascades to questions/answers) and reinsert.
        await trx.deleteFrom('tickets').where('examId', '=', id).execute();
        await this.replaceTickets(trx, id, existing.subjectId, teacherId, dto.tickets);
      }
      return this.getOneWithTrx(trx, id);
    });
  }

  private async replaceTickets(
    trx: Transaction<DB>,
    examId: string,
    subjectId: string,
    authorId: string,
    tickets: ExamTicketDto[],
  ) {
    if (tickets.length === 0) return;

    // 1. Bulk-insert all tickets in one statement, returning their generated
    //    ids keyed by position (Postgres RETURNING order isn't guaranteed, so
    //    we map by the position we set rather than relying on row order).
    const ticketRows = tickets.map((t, i) => ({
      examId,
      subjectId,
      authorId,
      title: t.title?.trim() || `Билет №${i + 1}`,
      position: i + 1,
    }));
    const inserted = await trx
      .insertInto('tickets')
      .values(ticketRows as any)
      .returning(['id', 'position'])
      .execute();
    const idByPosition = new Map<number, string>(
      inserted.map((r) => [r.position as number, r.id as string]),
    );

    // 2. Bulk-insert every question across all tickets in a single statement.
    const questionRows = tickets.flatMap((t, i) => {
      const ticketId = idByPosition.get(i + 1)!;
      return t.questions.map((q, idx) => ({
        ticketId,
        position: idx,
        type: q.type,
        text: q.text,
        points: q.points,
        timeSec: q.time,
        difficulty: q.difficulty,
        payload: JSON.stringify(this.extractPayload(q)),
      }));
    });
    if (questionRows.length > 0) {
      await trx.insertInto('questions').values(questionRows as any).execute();
    }
  }

  // ───────────── Publish ─────────────
  async publish(teacherId: string, id: string) {
    await this.requireOwned(teacherId, id);
    await this.db
      .updateTable('exams')
      .set({ status: 'Опубликован', updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
    return this.getOne(teacherId, id);
  }

  // ───────────── Share / join URL ─────────────
  /**
   * Find the most recent scheduled or live session for this exam, or create a
   * new scheduled one. Used by the "Поделиться" button — the teacher gets a
   * stable join URL without spawning a fresh session on every click.
   */
  async findOrCreateShareSession(teacherId: string, examId: string) {
    await this.requireOwned(teacherId, examId);

    const existing = await this.db
      .selectFrom('sessions')
      .select(['id', 'status'])
      .where('examId', '=', examId)
      .where('teacherId', '=', teacherId)
      .where('status', 'in', ['scheduled', 'live'])
      .orderBy(sql`case when status = 'live' then 0 else 1 end`)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (existing) {
      return { sessionId: existing.id, status: existing.status, reused: true };
    }

    const firstTicket = await this.db
      .selectFrom('tickets')
      .select(['id'])
      .where('examId', '=', examId)
      .orderBy('position')
      .limit(1)
      .executeTakeFirst();
    if (!firstTicket) throw new BadRequestException('Exam has no tickets yet');

    const created = await this.db
      .insertInto('sessions')
      .values({
        examId,
        ticketId: firstTicket.id,
        teacherId,
        ticketsPolicy: 'one-per-student',
        status: 'scheduled',
      } as any)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    return { sessionId: created.id, status: created.status, reused: false };
  }

  // ───────────── Delete ─────────────
  async remove(teacherId: string, id: string): Promise<void> {
    await this.requireOwned(teacherId, id);
    await this.db.deleteFrom('exams').where('id', '=', id).execute();
  }

  // ───────────── Tickets (within exam) ─────────────
  async addTicket(
    teacherId: string,
    examId: string,
    body: { title?: string; questions: QuestionDto[] },
  ) {
    await this.requireOwned(teacherId, examId);
    return this.db.transaction().execute(async (trx) => {
      const last = await trx
        .selectFrom('tickets')
        .select(sql<number>`coalesce(max(position), 0)::int`.as('maxPos'))
        .where('examId', '=', examId)
        .executeTakeFirstOrThrow();
      const position = (last.maxPos ?? 0) + 1;

      const exam = await trx
        .selectFrom('exams')
        .select(['subjectId', 'authorId'])
        .where('id', '=', examId)
        .executeTakeFirstOrThrow();

      const ticket = await trx
        .insertInto('tickets')
        .values({
          examId,
          subjectId: exam.subjectId,
          authorId: exam.authorId,
          title: body.title ?? `Билет №${position}`,
          position,
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await this.insertQuestions(trx, ticket.id, body.questions);
      return this.getOneWithTrx(trx, examId);
    });
  }

  // ───────────── Helpers ─────────────
  private async requireOwned(teacherId: string, examId: string) {
    const exam = await this.db
      .selectFrom('exams')
      .selectAll()
      .where('id', '=', examId)
      .executeTakeFirst();
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.authorId !== teacherId) throw new ForbiddenException();
    return exam;
  }

  private async assertSubjectOwnership(teacherId: string, subjectId: string): Promise<void> {
    const subj = await this.db
      .selectFrom('subjects')
      .select('teacherId')
      .where('id', '=', subjectId)
      .executeTakeFirst();
    if (!subj) throw new NotFoundException('Subject not found');
    if (subj.teacherId !== teacherId) throw new ForbiddenException('Not your subject');
  }

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

  private async getOneWithTrx(trx: Transaction<DB>, examId: string) {
    const exam = await trx.selectFrom('exams').selectAll().where('id', '=', examId).executeTakeFirstOrThrow();
    const tickets = await trx
      .selectFrom('tickets')
      .selectAll()
      .where('examId', '=', examId)
      .orderBy('position')
      .execute();
    const ticketIds = tickets.map((t) => t.id);
    const questions = ticketIds.length
      ? await trx
          .selectFrom('questions')
          .selectAll()
          .where('ticketId', 'in', ticketIds)
          .orderBy('position')
          .execute()
      : [];
    const byTicket = new Map<string, any[]>();
    for (const q of questions) {
      const arr = byTicket.get(q.ticketId) ?? [];
      arr.push(this.deserializeQuestion(q));
      byTicket.set(q.ticketId, arr);
    }
    return {
      ...exam,
      tickets: tickets.map((t) => ({
        id: t.id,
        title: t.title,
        position: t.position,
        questions: byTicket.get(t.id) ?? [],
      })),
    };
  }

  private relativeTime(d: Date): string {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Только что';
    if (mins < 60) return `${mins} мин назад`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} ч назад`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return '1 день назад';
    if (days < 7) return `${days} дн назад`;
    const weeks = Math.floor(days / 7);
    if (weeks === 1) return '1 неделю назад';
    return `${weeks} недель назад`;
  }
}
