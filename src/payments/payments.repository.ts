import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { PaymentStatus } from '@demo/contracts';
import { PaymentEntity, PaymentDocument } from './schemas/payment.schema';

@Injectable()
export class PaymentsRepository {
  constructor(
    @InjectModel(PaymentEntity.name) private readonly model: Model<PaymentDocument>,
  ) {}

  async create(
    data: { orderId: string; sagaId: string; userId: string; amount: number; status: PaymentStatus },
    session?: ClientSession,
  ): Promise<PaymentDocument> {
    const docs = await this.model.create([data], session ? { session } : {});
    return docs[0];
  }

  async findById(id: string): Promise<PaymentDocument> {
    const doc = await this.model.findById(id).exec();
    if (!doc) throw new NotFoundException(`Payment ${id} not found`);
    return doc;
  }

  async findBySagaId(sagaId: string, session?: ClientSession): Promise<PaymentDocument | null> {
    return this.model.findOne({ sagaId }, null, session ? { session } : {}).exec();
  }

  async findAll(
    page: number,
    limit: number,
    filter: { orderId?: string; userId?: string },
  ): Promise<{ data: any[]; total: number }> {
    const query: Record<string, string> = {};
    if (filter.orderId) query.orderId = filter.orderId;
    if (filter.userId) query.userId = filter.userId;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.model.find(query).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments(query).exec(),
    ]);
    return { data: data as any[], total };
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    session?: ClientSession,
  ): Promise<PaymentDocument> {
    const doc = await this.model
      .findByIdAndUpdate(id, { $set: { status } }, { new: true, session })
      .exec();
    if (!doc) throw new NotFoundException(`Payment ${id} not found`);
    return doc;
  }
}
