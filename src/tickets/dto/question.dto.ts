import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';

export type QuestionType = 'single' | 'multi' | 'text' | 'numeric' | 'verbal';

/** Verbal answers are graded by the teacher on a 5-point scale. */
export const MAX_VERBAL_POINTS = 5;

const VerbalPointsCap = () =>
  ValidateBy({
    name: 'verbalPointsCap',
    validator: {
      validate: (value, args) =>
        (args?.object as { type?: QuestionType }).type !== 'verbal' || value <= MAX_VERBAL_POINTS,
      defaultMessage: () => `points must not exceed ${MAX_VERBAL_POINTS} for verbal questions`,
    },
  });

export class QuestionPayloadDto {
  // single/multi
  @IsOptional() @IsArray() @IsString({ each: true }) answers?: string[];
  @IsOptional() correct?: number | number[];
  // text
  @IsOptional() @IsString() expected?: string | number;
  @IsOptional() @IsNumber() tolerance?: number;
  // verbal
  @IsOptional() @IsString() rubric?: string;
}

export class QuestionDto {
  @ApiProperty({ enum: ['single', 'multi', 'text', 'numeric', 'verbal'], example: 'single' })
  @IsIn(['single', 'multi', 'text', 'numeric', 'verbal'])
  type!: QuestionType;

  @ApiProperty({ example: 'Чему равна сумма вероятностей всех элементарных исходов?' })
  @IsString()
  text!: string;

  @ApiProperty({ example: 5, minimum: 0, maximum: 100, description: `Verbal questions: max ${MAX_VERBAL_POINTS}` })
  @IsInt() @Min(0) @Max(100) @VerbalPointsCap()
  points!: number;

  @ApiProperty({ example: 60, description: 'Per-question time limit (seconds). For verbal: soft cap.' })
  @IsInt() @Min(1) @Max(36000)
  time!: number;

  @ApiProperty({ enum: ['easy', 'medium', 'hard'], example: 'medium' })
  @IsIn(['easy', 'medium', 'hard'])
  difficulty!: 'easy' | 'medium' | 'hard';

  @ApiPropertyOptional({ type: [String], example: ['0', '0.5', '1', '∞'], description: 'MCQ answers (single/multi)' })
  @IsOptional() @IsArray() @IsString({ each: true }) answers?: string[];

  @ApiPropertyOptional({ description: 'Index for single (number) or indices for multi (number[])', example: 2 })
  @IsOptional() correct?: number | number[];

  @ApiPropertyOptional({ description: 'Expected value for text/numeric questions', example: 'Paris' })
  @IsOptional() expected?: string | number;

  @ApiPropertyOptional({ description: 'Numeric tolerance', example: 0.01 })
  @IsOptional() @IsNumber() tolerance?: number;

  @ApiPropertyOptional({ description: 'Teacher-only verbal rubric (never shown to students)' })
  @IsOptional() @IsString() rubric?: string;
}

export class TicketDetailsDto {
  @ApiProperty({ example: 'Весенний итоговый экзамен' })
  @IsString() title!: string;

  @ApiPropertyOptional({ example: 'Открытая книга разрешена.' })
  @IsOptional() @IsString() description?: string;

  @ApiProperty({ example: 90, description: 'Total ticket duration in minutes' })
  @IsInt() @Min(5) @Max(600) duration!: number;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(10) attempts?: number;

  @ApiPropertyOptional({ enum: ['private', 'department', 'public'], default: 'private' })
  @IsOptional() @IsIn(['private', 'department', 'public']) visibility?: 'private' | 'department' | 'public';

  @ApiPropertyOptional({ enum: ['fixed', 'shuffle', 'random-bank'], default: 'fixed' })
  @IsOptional() @IsIn(['fixed', 'shuffle', 'random-bank']) shuffle?: 'fixed' | 'shuffle' | 'random-bank';
}

export class UpdateTicketDto {
  @ApiPropertyOptional({ description: 'Ticket label (e.g. "Билет №1")' })
  @IsOptional() @IsString() title?: string;

  @ApiPropertyOptional({ type: [QuestionDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuestionDto) questions?: QuestionDto[];
}
