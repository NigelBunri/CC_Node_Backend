// src/chat/features/sync/sync.service.ts
import { Injectable } from '@nestjs/common';
import { MessagesService } from '../messages/messages.service';

@Injectable()
export class SyncService {
  constructor(private readonly messages: MessagesService) {}

  async gapCheck(conversationId: string, fromSeq: number, toSeq: number) {
    const missing = await this.messages.findMissingSeqs(conversationId, fromSeq, toSeq);
    const messages = await this.messages.getRange(conversationId, fromSeq, toSeq);
    return { missing, messages };
  }
}
