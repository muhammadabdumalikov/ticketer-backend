import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuestionDto } from '../../tickets/dto/question.dto';

export class ExamDetailsDto {
  @ApiProperty({ example: 'Весенний итоговый экзамен' })
  @IsString()
  title!: string;

  @ApiPropertyOptional({ example: 'Открытая книга разрешена.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 90, description: 'Total exam duration in minutes' })
  @IsInt()
  @Min(5)
  @Max(600)
  duration!: number;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  attempts?: number;

  @ApiPropertyOptional({ enum: ['private', 'department', 'public'], default: 'private' })
  @IsOptional()
  @IsIn(['private', 'department', 'public'])
  visibility?: 'private' | 'department' | 'public';

  @ApiPropertyOptional({ enum: ['fixed', 'shuffle', 'random-bank'], default: 'fixed' })
  @IsOptional()
  @IsIn(['fixed', 'shuffle', 'random-bank'])
  shuffle?: 'fixed' | 'shuffle' | 'random-bank';
}

export class ExamTicketDto {
  @ApiPropertyOptional({ description: 'Optional label (defaults to "Билет №N").' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ type: [QuestionDto], minItems: 1, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  questions!: QuestionDto[];
}

export class CreateExamDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  subjectId!: string;

  @ApiProperty({ type: ExamDetailsDto })
  @ValidateNested()
  @Type(() => ExamDetailsDto)
  details!: ExamDetailsDto;

  @ApiProperty({ type: [ExamTicketDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExamTicketDto)
  tickets!: ExamTicketDto[];
}

export class UpdateExamDto {
  @ApiPropertyOptional({ type: ExamDetailsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExamDetailsDto)
  details?: ExamDetailsDto;

  @ApiPropertyOptional({ type: [ExamTicketDto], description: 'Full replacement of tickets if provided' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExamTicketDto)
  tickets?: ExamTicketDto[];
}
