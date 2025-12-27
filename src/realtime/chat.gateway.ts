// src/realtime/chat.gateway.ts

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { WsAuthGuard } from '../auth/ws-auth.guard';
import * as chatTypes from '../chat/chat.types';

import { FF } from '../chat/feature-flags';

import { ReactionsService } from '../chat/features/reactions/reactions.service';
import { ReceiptsService } from '../chat/features/receipts/receipts.service';
import { SyncService } from '../chat/features/sync/sync.service';

import { DjangoConversationClient } from '../chat/integrations/django/django-conversation.client';
import { DjangoSeqClient } from '../chat/integrations/django/django-seq.client';
import { RateLimitService } from '../chat/infra/rate-limit/rate-limit.service';

import { MessagesService } from '../chat/features/messages/messages.service';
import { PresenceService } from '../chat/features/presence/presence.service';

import { SendMessageDto } from '../chat/features/messages/messages.dto';

// Batch B services (safe to inject; gated by FF.*)
import { ThreadsService } from '../chat/features/threads/threads.service';
import { PinsService } from '../chat/features/pins/pins.service';
import { StarsService } from '../chat/features/stars/stars.service';
import { ModerationService } from '../chat/features/moderation/moderation.service';
import { CallStateService } from '../chat/features/calls/call-state.service';

type AuthedSocket = Socket & { principal?: chatTypes.SocketPrincipal };

type JoinPayload = { conversationId: string };
type LeavePayload = { conversationId: string };

type EditPayload = {
  conversationId: string;
  messageId: string;
  ciphertext?: string;
  encryptionMeta?: Record<string, any>;
  text?: string;
  attachments?: any[];
};

type DeletePayload = {
  conversationId: string;
  messageId: string;
  mode: 'deleted_for_me' | 'deleted_for_everyone';
};

type ReactionPayload = {
  conversationId: string;
  messageId: string;
  emoji: string;
  mode: 'add' | 'remove';
};

type ReceiptPayload = {
  conversationId: string;
  messageId: string;
  type: 'delivered' | 'read' | 'played';
  atMs?: number;
};

type TypingPayload = {
  conversationId: string;
  isTyping: boolean;
};

type GapCheckPayload = {
  conversationId: string;
  fromSeq: number;
  toSeq: number;
};

type CallOfferPayload = { conversationId: string; callId: string; toUserId: string; sdp: any };
type CallAnswerPayload = { conversationId: string; callId: string; toUserId: string; sdp: any };
type CallIcePayload = { conversationId: string; callId: string; toUserId: string; candidate: any };
type CallHangupPayload = { conversationId: string; callId: string; toUserId: string; reason?: string };

@WebSocketGateway({
  path: process.env.WS_PATH || '/ws',
  cors: { origin: (process.env.ORIGINS ?? '*').split(',') },
})
@UseGuards(WsAuthGuard)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    // Batch A
    private readonly messages: MessagesService,
    private readonly reactions: ReactionsService,
    private readonly receipts: ReceiptsService,
    private readonly sync: SyncService,
    private readonly perms: DjangoConversationClient,
    private readonly seqClient: DjangoSeqClient,
    private readonly rate: RateLimitService,
    private readonly presence: PresenceService,

    // Batch B (gated)
    private readonly threads: ThreadsService,
    private readonly pins: PinsService,
    private readonly stars: StarsService,
    private readonly moderation: ModerationService,
    private readonly callState: CallStateService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    const p = client.principal;
    if (!p?.userId) {
      client.disconnect(true);
      return;
    }

    client.join(chatTypes.rooms.userRoom(p.userId));
    this.presence.markOnline(p.userId);

    this.server.emit(chatTypes.EVT.PRESENCE, { userId: p.userId, state: 'online', at: Date.now() });
    this.logger.log(`connected user=${p.userId}`);
  }

  async handleDisconnect(client: AuthedSocket) {
    const p = client.principal;
    if (!p?.userId) return;

    this.presence.markOffline(p.userId);
    this.server.emit(chatTypes.EVT.PRESENCE, { userId: p.userId, state: 'offline', at: Date.now() });
    this.logger.log(`disconnected user=${p.userId}`);
  }

  @SubscribeMessage(chatTypes.EVT.JOIN)
  async onJoin(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: JoinPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'join');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);
      client.join(chatTypes.rooms.convRoom(payload.conversationId));

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.LEAVE)
  async onLeave(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: LeavePayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'leave');

      client.leave(chatTypes.rooms.convRoom(payload.conversationId));
      return { ok: true };
    });
  }

  // ✅ Batch A send: uses canonical SendMessageDto + idempotent create
  @SubscribeMessage(chatTypes.EVT.SEND)
  async onSend(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: SendMessageDto) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'send');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const seq =
        (this.seqClient as any).allocateSeq
          ? await (this.seqClient as any).allocateSeq(payload.conversationId)
          : await (this.seqClient as any).allocate(payload.conversationId);

      const doc = await this.messages.createIdempotent({
        senderId: p.userId,
        seq,
        input: payload,
      });

      const dto = this.toMessageDTO(doc);

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.MESSAGE, dto);
      this.server.to(chatTypes.rooms.userRoom(p.userId)).emit(chatTypes.EVT.MESSAGE, dto);

      return {
        ok: true,
        data: {
          clientId: dto.clientId,
          serverId: dto.id,
          seq: dto.seq,
          createdAt: dto.createdAt,
        },
      };
    });
  }

  @SubscribeMessage(chatTypes.EVT.EDIT)
  async onEdit(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: EditPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'edit');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.messages.editMessage({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        editorId: p.userId,
        editorDeviceId: (p as any).deviceId ?? 'device',
        ciphertext: payload.ciphertext,
        encryptionMeta: payload.encryptionMeta,
        text: payload.text,
        attachments: payload.attachments,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(updated);

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.MESSAGE_EDITED, dto);
      this.server.to(chatTypes.rooms.userRoom(p.userId)).emit(chatTypes.EVT.MESSAGE_EDITED, dto);

      return { ok: true, message: dto };
    });
  }

  @SubscribeMessage(chatTypes.EVT.DELETE)
  async onDelete(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: DeletePayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'delete');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.messages.deleteMessage({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        requesterId: p.userId,
        mode: payload.mode,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(updated);

      const eventPayload = {
        messageId: payload.messageId,
        conversationId: payload.conversationId,
        mode: payload.mode,
        deletedAt: (updated as any).deletedAt ?? Date.now(),
        deletedBy: (updated as any).deletedBy ?? p.userId,
        message: dto,
      };

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.MESSAGE_DELETED, eventPayload);
      this.server.to(chatTypes.rooms.userRoom(p.userId)).emit(chatTypes.EVT.MESSAGE_DELETED, eventPayload);

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.REACT)
  async onReact(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: ReactionPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'react');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.reactions.react({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        userId: p.userId,
        emoji: payload.emoji,
        mode: payload.mode,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(updated);

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.MESSAGE_REACTION, {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reactions: (dto as any).reactions ?? [],
      });

      this.server.to(chatTypes.rooms.userRoom(p.userId)).emit(chatTypes.EVT.MESSAGE_REACTION, {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reactions: (dto as any).reactions ?? [],
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.RECEIPT)
  async onReceipt(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: ReceiptPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'receipt');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.receipts.addReceipt({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        userId: p.userId,
        deviceId: (p as any).deviceId ?? `socket:${client.id}`,
        type: payload.type,
        atMs: payload.atMs,
      });

      const dto = this.toMessageDTO(updated);

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.MESSAGE_RECEIPT, {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        deliveredTo: (dto as any).deliveredTo ?? [],
        readBy: (dto as any).readBy ?? [],
        playedBy: (dto as any).playedBy ?? [],
      });

      this.server.to(chatTypes.rooms.userRoom(p.userId)).emit(chatTypes.EVT.MESSAGE_RECEIPT, {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        deliveredTo: (dto as any).deliveredTo ?? [],
        readBy: (dto as any).readBy ?? [],
        playedBy: (dto as any).playedBy ?? [],
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.TYPING)
  async onTyping(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: TypingPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'typing');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      client.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.TYPING, {
        conversationId: payload.conversationId,
        userId: p.userId,
        isTyping: !!payload.isTyping,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.GAP_CHECK)
  async onGapCheck(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: GapCheckPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'gap');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const { missing, messages } = await this.sync.gapCheck(payload.conversationId, payload.fromSeq, payload.toSeq);
      const dtos = (messages ?? []).map((m: any) => this.toMessageDTO(m));

      if (dtos.length) {
        client.emit(chatTypes.EVT.GAP_FILL, {
          conversationId: payload.conversationId,
          fromSeq: payload.fromSeq,
          toSeq: payload.toSeq,
          messages: dtos,
        });
      }

      return { ok: true, missing: missing ?? [] };
    });
  }

  // ==========================
  // Batch B (feature-flagged)
  // ==========================

  @SubscribeMessage(chatTypes.EVT.THREAD_CREATE)
  async onThreadCreate(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: chatTypes.ThreadCreatePayload) {
    return this.safeAck(async () => {
      if (!FF.THREADS) return { ok: false, code: 'Disabled', message: 'Threads disabled' };

      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'thread.create');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const thread = await this.threads.createThread({
        conversationId: payload.conversationId,
        rootMessageId: payload.rootMessageId,
        createdBy: p.userId,
        title: payload.title,
      });

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.THREAD_CREATE, {
        conversationId: payload.conversationId,
        threadId: String((thread as any)._id),
        rootMessageId: (thread as any).rootMessageId,
        title: (thread as any).title,
        createdBy: (thread as any).createdBy,
        createdAt: (thread as any).createdAt,
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.THREAD_JOIN)
  async onThreadJoin(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: chatTypes.ThreadJoinPayload) {
    return this.safeAck(async () => {
      if (!FF.THREADS) return { ok: false, code: 'Disabled', message: 'Threads disabled' };

      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'thread.join');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      client.join(chatTypes.rooms.threadRoom(payload.conversationId, payload.threadId));
      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.THREAD_LEAVE)
  async onThreadLeave(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: chatTypes.ThreadJoinPayload) {
    return this.safeAck(async () => {
      if (!FF.THREADS) return { ok: false, code: 'Disabled', message: 'Threads disabled' };

      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'thread.leave');

      client.leave(chatTypes.rooms.threadRoom(payload.conversationId, payload.threadId));
      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.PIN_SET)
  async onPinSet(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: chatTypes.PinSetPayload) {
    return this.safeAck(async () => {
      if (!FF.PINS) return { ok: false, code: 'Disabled', message: 'Pins disabled' };

      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'pin');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const res = await this.pins.setPinned({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        userId: p.userId,
        pinned: payload.pinned,
      });

      this.server.to(chatTypes.rooms.convRoom(payload.conversationId)).emit(chatTypes.EVT.PIN_SET, {
        ...payload,
        pinned: res.pinned,
        by: p.userId,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.STAR_SET)
  async onStarSet(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: chatTypes.StarSetPayload) {
    return this.safeAck(async () => {
      if (!FF.STARS) return { ok: false, code: 'Disabled', message: 'Stars disabled' };

      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'star');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const res = await this.stars.setStarred({
        userId: p.userId,
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        starred: payload.starred,
      });

      this.server.to(chatTypes.rooms.userRoom(p.userId)).emit(chatTypes.EVT.STAR_SET, {
        ...payload,
        starred: res.starred,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.REPORT_MESSAGE)
  async onReportMessage(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: chatTypes.ReportMessagePayload) {
    return this.safeAck(async () => {
      if (!FF.MODERATION) return { ok: false, code: 'Disabled', message: 'Moderation disabled' };

      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'report');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      await this.moderation.reportMessage({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reportedBy: p.userId,
        reason: payload.reason,
        note: payload.note,
      });

      return { ok: true };
    });
  }

  // Call handlers: keep your existing ones; optionally persist state:
  @SubscribeMessage(chatTypes.EVT.CALL_OFFER)
  async onCallOffer(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallOfferPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      if (FF.CALL_STATE) {
        await this.callState.upsertState({
          conversationId: payload.conversationId,
          callId: payload.callId,
          fromUserId: p.userId,
          toUserId: payload.toUserId,
          state: 'ringing',
          startedAtMs: Date.now(),
        });
      }

      this.server.to(chatTypes.rooms.userRoom(payload.toUserId)).emit(chatTypes.EVT.CALL_OFFER, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        sdp: payload.sdp,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.CALL_ANSWER)
  async onCallAnswer(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallAnswerPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      if (FF.CALL_STATE) {
        await this.callState.upsertState({
          conversationId: payload.conversationId,
          callId: payload.callId,
          fromUserId: p.userId,
          toUserId: payload.toUserId,
          state: 'active',
          startedAtMs: Date.now(),
        });
      }

      this.server.to(chatTypes.rooms.userRoom(payload.toUserId)).emit(chatTypes.EVT.CALL_ANSWER, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        sdp: payload.sdp,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.CALL_ICE)
  async onCallIce(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallIcePayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      this.server.to(chatTypes.rooms.userRoom(payload.toUserId)).emit(chatTypes.EVT.CALL_ICE, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        candidate: payload.candidate,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(chatTypes.EVT.CALL_HANGUP)
  async onCallHangup(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallHangupPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');
      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      if (FF.CALL_STATE) {
        await this.callState.upsertState({
          conversationId: payload.conversationId,
          callId: payload.callId,
          fromUserId: p.userId,
          toUserId: payload.toUserId,
          state: 'ended',
          endedAtMs: Date.now(),
          endedReason: payload.reason ?? 'hangup',
        });
      }

      this.server.to(chatTypes.rooms.userRoom(payload.toUserId)).emit(chatTypes.EVT.CALL_HANGUP, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        reason: payload.reason ?? 'hangup',
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  private requirePrincipal(client: AuthedSocket): chatTypes.SocketPrincipal {
    const p = client.principal;
    if (!p?.userId) throw new WsException('unauthorized');
    return p;
  }

  private async safeAck<T>(fn: () => Promise<T>): Promise<T | { ok: false; code: string; message: string }> {
    try {
      return await fn();
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : 'error';
      const code = typeof e?.name === 'string' ? e.name : 'Error';
      return { ok: false, code, message: msg };
    }
  }

  private toMessageDTO(message: any) {
    return {
      id: String(message._id ?? message.id ?? message.serverId),
      conversationId: message.conversationId,
      seq: message.seq,
      clientId: message.clientId,
      senderId: message.senderId,

      kind: message.kind,

      text: message.text,
      styledText: message.styledText,
      voice: message.voice,
      sticker: message.sticker,
      attachments: message.attachments ?? [],
      contacts: message.contacts ?? [],
      poll: message.poll,
      event: message.event,
      replyToId: message.replyToId,

      isEdited: !!message.isEdited,
      isDeleted: !!message.isDeleted,

      createdAt: message.createdAt?.toISOString?.() ?? message.createdAt,
      updatedAt: message.updatedAt?.toISOString?.() ?? message.updatedAt,
    };
  }
}
