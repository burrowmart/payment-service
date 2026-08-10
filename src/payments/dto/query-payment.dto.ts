import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryPaymentDto {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Filter by orderId' })
  orderId?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Filter by userId (email)' })
  userId?: string;
}
