import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSessionDto {
  @ApiProperty({ format: 'uuid', description: 'Exam to launch — server picks a ticket from its pool.' })
  @IsUUID() examId!: string;

  @ApiPropertyOptional({ example: '2026-05-24T14:00:00Z' })
  @IsOptional() @IsISO8601() scheduledAt?: string;

  @ApiPropertyOptional({
    enum: ['one-per-student', 'allow-duplicates'],
    default: 'one-per-student',
  })
  @IsOptional() @IsIn(['one-per-student', 'allow-duplicates'])
  ticketsPolicy?: 'one-per-student' | 'allow-duplicates';
}

export class JoinSessionDto {
  @ApiProperty({ example: 'Михаил Соколов' })
  @IsString() @Length(2, 200) name!: string;

  @ApiProperty({ example: 'ИВТ-301' })
  @IsString() @Length(1, 50) group!: string;

  @ApiPropertyOptional({ example: '23-1284' })
  @IsOptional() @IsString() @Length(0, 50) studentNumber?: string;
}

export class AnswerItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID() questionId!: string;

  @ApiPropertyOptional({ description: 'Index for single-choice questions', example: 1 })
  @IsOptional() @IsInt() @Min(0) selectedIndex?: number;

  @ApiPropertyOptional({ description: 'Indices for multi-choice questions', type: [Number] })
  @IsOptional() selectedIndices?: number[];

  @ApiPropertyOptional({ description: 'Text answer for text questions' })
  @IsOptional() @IsString() textValue?: string;

  @ApiPropertyOptional({ description: 'Numeric answer for numeric questions' })
  @IsOptional() numericValue?: number;
}

export class SubmitAnswersDto {
  @ApiProperty({ type: [AnswerItemDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => AnswerItemDto)
  answers!: AnswerItemDto[];
}

export class VerbalActionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID() memberId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID() questionId!: string;
}

export class GradeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID() memberId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID() questionId!: string;

  @ApiProperty({ example: 8, minimum: 0, description: 'Points awarded (≤ question.points)' })
  @IsInt() @Min(0) pointsAwarded!: number;

  @ApiPropertyOptional({ example: 'Хороший ответ, не раскрыт пункт о ЦПТ' })
  @IsOptional() @IsString() notes?: string;
}
