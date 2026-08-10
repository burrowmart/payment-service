import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { QueryPaymentDto } from './dto/query-payment.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Get()
  @ApiOkResponse({ description: 'Paginated payment list' })
  findAll(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query() query: QueryPaymentDto,
  ) {
    return this.service.findAll(+page, +limit, query);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Payment found' })
  @ApiNotFoundResponse({ description: 'Payment not found' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }
}
