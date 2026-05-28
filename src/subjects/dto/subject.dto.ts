import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateSubjectDto {
  @ApiProperty({ example: 'Теория графов' })
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiProperty({ example: 'MATH-380' })
  @IsString()
  @Length(2, 50)
  code!: string;

  @ApiProperty({ example: 'ТГ', description: '2-3 char short code shown on subject card' })
  @IsString()
  @Length(1, 6)
  sigil!: string;

  @ApiProperty({ example: '#FF4D1F' })
  @IsHexColor()
  color!: string;

  @ApiPropertyOptional({ enum: ['active', 'live', 'draft'], default: 'active' })
  @IsOptional()
  @IsIn(['active', 'live', 'draft'])
  status?: 'active' | 'live' | 'draft';
}

export class UpdateSubjectDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @Length(2, 50) code?: string;
  @IsOptional() @IsString() @Length(1, 6) sigil?: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsIn(['active', 'live', 'draft']) status?: 'active' | 'live' | 'draft';
}
