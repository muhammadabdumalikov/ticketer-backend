import { BadRequestException } from '@nestjs/common';

/**
 * Shape of a multipart file as produced by multer's memory storage
 * (the default for @nestjs/platform-express FileInterceptor). Typed locally so
 * we don't need to depend on @types/multer.
 */
export interface UploadedDocx {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/** A single parsed question. Imported bullets become manually-graded verbal questions. */
export interface ParsedQuestion {
  type: 'verbal';
  text: string;
  points: number;
  time: number;
  difficulty: 'medium';
  rubric: string;
}

export interface ParsedTicket {
  /** Optional label; omitted so the client assigns its localized default ("Билет №N"). */
  title?: string;
  questions: ParsedQuestion[];
}

export interface ParsedDocxExam {
  /** Heading text found before the first variant, if any. */
  title?: string;
  tickets: ParsedTicket[];
}

// Sensible defaults for an open-ended oral-exam question. The teacher can tune
// points/time per question in the builder before publishing.
const DEFAULT_POINTS = 10;
const DEFAULT_TIME_SEC = 300;

/**
 * A line is a "variant" (ticket) header when, after trimming, it consists ONLY
 * of a variant/билет marker plus an optional number — e.g. "1-variant",
 * "2 - variant", "Variant 3", "вариант 1", "Билет №2", "1-bilet". The trailing
 * `$` anchors prevent a real question that merely contains the word from matching.
 */
function isVariantHeader(line: string): boolean {
  return (
    /^\s*\d+\s*[-–—.)\s]\s*(?:variant|varianti|вариант|bilet|билет)\s*[:.]?\s*$/i.test(
      line,
    ) ||
    /^\s*(?:variant|varianti|вариант|bilet|билет)\s*[-–—.)№#]?\s*\d*\s*[:.]?\s*$/i.test(
      line,
    )
  );
}

/** Remove a leading bullet glyph or "1." / "1)" numbering from a question line. */
function stripBullet(line: string): string {
  return line
    .replace(/^[\s•‣◦⁃∙▪·*+\-–—]+/, '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .trim();
}

function makeQuestion(text: string): ParsedQuestion {
  return {
    type: 'verbal',
    text,
    points: DEFAULT_POINTS,
    time: DEFAULT_TIME_SEC,
    difficulty: 'medium',
    rubric: '',
  };
}

/**
 * Turn the raw text of a .docx (as produced by mammoth.extractRawText) into an
 * exam structure: each "N-variant" line starts a new ticket, and every bullet /
 * non-empty line under it becomes a verbal question.
 *
 * Throws BadRequestException when no questions can be found.
 */
export function parseExamDocx(rawText: string): ParsedDocxExam {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, ' ').trim())
    .filter((l) => l.length > 0);

  const tickets: ParsedTicket[] = [];
  let current: ParsedTicket | null = null;
  let title: string | undefined;

  for (const line of lines) {
    if (isVariantHeader(line)) {
      current = { questions: [] };
      tickets.push(current);
      continue;
    }
    const text = stripBullet(line);
    if (!text) continue;

    if (!current) {
      // Text before the first variant header: treat the first such line as the
      // exam title, ignore any others.
      if (title === undefined) title = text;
      continue;
    }
    current.questions.push(makeQuestion(text));
  }

  // No variant headers at all → treat the whole document as one ticket of
  // questions (best-effort fallback).
  if (tickets.length === 0) {
    const questions = lines
      .map(stripBullet)
      .filter((t) => t.length > 0)
      .map(makeQuestion);
    if (questions.length === 0) {
      throw new BadRequestException(
        'Не удалось найти вопросы в документе. Проверьте формат файла.',
      );
    }
    return { tickets: [{ questions }] };
  }

  const nonEmpty = tickets.filter((t) => t.questions.length > 0);
  if (nonEmpty.length === 0) {
    throw new BadRequestException(
      'Найдены варианты, но без вопросов. Добавьте вопросы под каждым вариантом.',
    );
  }

  return { title, tickets: nonEmpty };
}
