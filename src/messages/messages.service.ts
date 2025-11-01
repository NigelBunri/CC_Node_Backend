import { Injectable } from '@nestjs/common';
import { AttachmentDto, SendMessageDto } from './dto/send-message.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MessageEntity, MessageDocument } from './schemas/message.schema';

// Keep your public message shape the same
type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  ciphertext?: string;
  createdAt: number;          // ms since epoch (converted from Mongo Date)
  replyToId?: string;
  attachments?: AttachmentDto[];
};

@Injectable()
export class MessagesService {
  constructor(
    @InjectModel(MessageEntity.name)
    private readonly model: Model<MessageDocument>,
  ) {}

  async save(userId: string, dto: SendMessageDto): Promise<Message> {
    const doc = await this.model.create({
      conversationId: dto.conversationId,
      senderId: userId,
      ciphertext: dto.ciphertext,
      replyToId: dto.replyToId,
      attachments: Array.isArray(dto.attachments) ? dto.attachments : [],
    });

    // Map Mongo -> your type (createdAt as number)
    return {
      id: doc._id.toString(),
      conversationId: doc.conversationId,
      senderId: doc.senderId,
      ciphertext: doc.ciphertext,
      createdAt: (doc as any).createdAt instanceof Date
        ? (doc as any).createdAt.getTime()
        : Date.now(),
      replyToId: doc.replyToId,
      attachments: (doc.attachments || []) as AttachmentDto[],
    };
  }

  async history(conversationId: string, limit = 30): Promise<Message[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);

    // Fetch newest-first then reverse to oldest-first (matches your previous logic)
    const docs = await this.model
      .find({ conversationId })
      .sort({ _id: -1 })
      .limit(safeLimit)
      .lean();

    return docs.reverse().map((d: any) => ({
      id: d._id.toString(),
      conversationId: d.conversationId,
      senderId: d.senderId,
      ciphertext: d.ciphertext,
      createdAt: d.createdAt instanceof Date ? d.createdAt.getTime() : Date.now(),
      replyToId: d.replyToId,
      attachments: (d.attachments || []) as AttachmentDto[],
    }));
  }
}
