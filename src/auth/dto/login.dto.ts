import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'teacher@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;
}
