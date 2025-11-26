import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AttachmentDto, SendMessageDto } from './dto/send-message.dto';
import { MessageEntity, MessageDocument } from './schemas/message.schema';

// Public message shape used by the gateway
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
  private readonly log = new Logger(MessagesService.name);

  constructor(
    @InjectModel(MessageEntity.name)
    private readonly model: Model<MessageDocument>,
  ) {}

  async save(userId: string, dto: SendMessageDto): Promise<Message> {
    this.log.debug(
      `save(): about to write message. db=${this.model.db.name}, collection=${this.model.collection.name}, data=${JSON.stringify({
        conversationId: dto.conversationId,
        senderId: userId,
        ciphertextPreview: dto.ciphertext
          ? dto.ciphertext.slice(0, 20) + '...'
          : null,
      })}`,
    );

    // If your schema has timestamps: true, Mongo will add createdAt automatically.
    // We still allow it, but don't rely on it being present in TypeScript.
    const doc = await this.model.create({
      conversationId: dto.conversationId,
      senderId: userId,
      ciphertext: dto.ciphertext,
      replyToId: dto.replyToId ?? null,
      attachments: Array.isArray(dto.attachments) ? dto.attachments : [],
      // createdAt can come from schema timestamps, but we set a fallback just in case
      // (Mongo will ignore this if timestamps is managing it).
      createdAt: new Date(),
    });

    const createdAtMs =
      (doc as any).createdAt instanceof Date
        ? (doc as any).createdAt.getTime()
        : Date.now();

    this.log.debug(
      `save(): wrote document. _id=${doc._id.toString()}, db=${this.model.db.name}, collection=${this.model.collection.name}, createdAt=${createdAtMs}`,
    );

    // Map Mongo -> your wire type
    return {
      id: doc._id.toString(),
      conversationId: doc.conversationId,
      senderId: doc.senderId,
      ciphertext: doc.ciphertext,
      createdAt: createdAtMs,
      replyToId: doc.replyToId,
      attachments: (doc.attachments || []) as AttachmentDto[],
    };
  }

  async history(conversationId: string, limit = 30): Promise<Message[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);

    this.log.debug(
      `history(): loading messages. db=${this.model.db.name}, collection=${this.model.collection.name}, conv=${conversationId}, limit=${safeLimit}`,
    );

    // newest-first then reverse to oldest-first
    const docs = await this.model
      .find({ conversationId })
      .sort({ _id: -1 })
      .limit(safeLimit)
      .lean()
      .exec();

    this.log.debug(
      `history(): got ${docs.length} messages for conv=${conversationId}`,
    );

    return docs.reverse().map((d: any) => ({
      id: d._id.toString(),
      conversationId: d.conversationId,
      senderId: d.senderId,
      ciphertext: d.ciphertext,
      createdAt:
        d.createdAt instanceof Date ? d.createdAt.getTime() : Date.now(),
      replyToId: d.replyToId,
      attachments: (d.attachments || []) as AttachmentDto[],
    }));
  }
}
