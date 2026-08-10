import { Injectable } from '@nestjs/common';
import type { Paginated, Payment } from '@demo/contracts';
import { PaymentsRepository } from './payments.repository';
import { QueryPaymentDto } from './dto/query-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(private readonly repo: PaymentsRepository) {}

  async findAll(page = 1, limit = 20, query: QueryPaymentDto): Promise<Paginated<Payment>> {
    const { data, total } = await this.repo.findAll(page, limit, query);
    return { data: data.map((d) => this.toResponse(d)), total, page, limit };
  }

  async findById(id: string): Promise<Payment> {
    const doc = await this.repo.findById(id);
    return this.toResponse(doc);
  }

  private toResponse(doc: any): Payment {
    const plain = typeof doc.toObject === 'function' ? doc.toObject({ versionKey: false }) : doc;
    return {
      id: String(plain._id),
      orderId: plain.orderId,
      userId: plain.userId,
      amount: plain.amount,
      status: plain.status,
      createdAt: plain.createdAt instanceof Date ? plain.createdAt.toISOString() : String(plain.createdAt ?? ''),
      updatedAt: plain.updatedAt instanceof Date ? plain.updatedAt.toISOString() : String(plain.updatedAt ?? ''),
    };
  }
}
