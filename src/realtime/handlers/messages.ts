// src/realtime/handlers/messages.handlers.ts

import { BadRequestException } from '@nestjs/common';
import { Socket } from 'socket.io';

import { EVT, Ack, SendMessageAck } from '../../chat/chat.types';
import { SendMessageDto } from '../../chat/features/messages/messages.dto';

import { MessagesService } from '../../chat/features/messages/messages.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { DjangoSeqClient } from '../../chat/integrations/django/django-seq.client';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';

import { convRoom } from './utils';

function ackErr(code: string, message: string, details?: any) {
  return { ok: false, error: { code, message, details } } as const;
}
function ackOk<T>(data: T) {
  return { ok: true, data } as const;
}

export class MessagesHandlers {
  constructor(
    private readonly messages: MessagesService,
    private readonly perms: DjangoConversationClient,
    private readonly seq: DjangoSeqClient,
    private readonly rate: RateLimitService,
  ) {}

  /**
   * Handle WS send message:
   * - auth principal already attached by WsAuthGuard
   * - ws-perms check
   * - rate limit
   * - allocate seq via Django
   * - idempotent save by (conversationId, clientId)
   * - emit chat.message
   */
  async onSendMessage(io: any, socket: Socket, body: SendMessageDto): Promise<Ack<SendMessageAck>> {
    const principal = socket.principal;
    if (!principal) return ackErr('AUTH_REQUIRED', 'Missing principal');

    // Basic guard
    if (!body?.conversationId || !body?.clientId || !body?.kind) {
      return ackErr('VALIDATION_FAILED', 'Missing required fields');
    }

    // Permission gate
    try {
      const p = await this.perms.wsPerms(body.conversationId, principal);
      if (!p?.isMember) return ackErr('FORBIDDEN', 'Not a member');
      if (p?.isBlocked) return ackErr('FORBIDDEN', 'Conversation is blocked');
      if (p?.dmState === 'pending') return ackErr('FORBIDDEN', 'DM request pending');
    } catch (e: any) {
      return ackErr('DJANGO_UNAVAILABLE', 'Permission check failed', { reason: e?.message });
    }

    // Rate limit
    try {
      this.rate.assertAllowed({
        key: `send:${principal.userId}`,
        limit: 25,
        windowMs: 5000,
      });
    } catch {
      return ackErr('RATE_LIMITED', 'Too many messages');
    }

    // Allocate seq
    let seq: number;
    try {
      seq = await this.seq.allocate(body.conversationId);
      if (!Number.isFinite(seq) || seq <= 0) throw new Error('bad seq');
    } catch (e: any) {
      return ackErr('DJANGO_UNAVAILABLE', 'Sequence allocation failed', { reason: e?.message });
    }

    // Save (idempotent)
    try {
      const doc = await this.messages.createIdempotent({
        senderId: principal.userId,
        seq,
        input: body,
      });

      // Emit to conversation room
      io.to(convRoom(body.conversationId)).emit(EVT.MESSAGE, {
        serverId: String(doc._id),
        clientId: doc.clientId,
        conversationId: doc.conversationId,
        seq: doc.seq,
        senderId: doc.senderId,
        kind: doc.kind,
        text: doc.text,
        styledText: doc.styledText,
        voice: doc.voice,
        sticker: doc.sticker,
        attachments: doc.attachments,
        contacts: doc.contacts,
        poll: doc.poll,
        event: doc.event,
        replyToId: doc.replyToId,
        isEdited: doc.isEdited,
        isDeleted: doc.isDeleted,
        createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: doc.updatedAt?.toISOString?.(),
      });

      return ackOk({
        clientId: doc.clientId,
        serverId: String(doc._id),
        seq: doc.seq,
        createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
      });
    } catch (e: any) {
      const msg = e instanceof BadRequestException ? e.message : 'Send failed';
      return ackErr('SEND_FAILED', msg, { reason: e?.message });
    }
  }
}
