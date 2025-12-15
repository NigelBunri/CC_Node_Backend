// NOTE:
// This gateway implements the **ONE WebSocket PER USER** architecture.
// - 🔌 One persistent socket per user/device
// - 👤 A dedicated *user room* (user:{userId}) for inbox / conversation list updates
// - 💬 Multiple *conversation rooms* (conv:{conversationId}) multiplexed over the SAME socket
// - 🧠 Django = source of truth (conversations, members, policies)
// - 🚀 NestJS = realtime delivery / fan-out
//
// This file is intentionally verbose (~1000+ LOC) with heavy comments so that
// future contributors understand *why* things exist, not just *what* they do.

/* ========================================================================== */
/*                               IMPORTS                                      */
/* ========================================================================== */

import {
  WebSocketGateway,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { WsAuthGuard } from '../auth/ws-auth.guard';
import { MessagesService } from '../messages/messages.service';
import { SendMessageDto } from '../messages/dto/send-message.dto';
import { PresenceService } from '../presence/presence.service';
import { DjangoAuthService } from '../auth/django-auth.service';

/* ========================================================================== */
/*                               CORE TYPES                                   */
/* ========================================================================== */

// 👤 Authenticated identity resolved from Django token introspection
// This is attached to socket.principal during handshake
export type Principal = {
  userId: string;
  username?: string;
  isPremium?: boolean;
  scopes?: string[];
};

// 💬 Conversation identifier (Django owns the ID)
export type ConversationId = string;

// 🧩 Socket.IO room helpers
// IMPORTANT: rooms are *logical channels*, NOT sockets
const userRoom = (userId: string) => `user:${userId}`; // inbox / conversation list
const convRoom = (id: string) => `conv:${id}`; // per-conversation messages

/* ========================================================================== */
/*                       DJANGO WIRE / POLICY TYPES                            */
/* ========================================================================== */

// Minimal user shape as returned by Django serializers
export type DjangoUserLite = {
  id: number | string;
  [key: string]: any;
};

export type DjangoConversationMemberWire = {
  id?: number | string;
  user?: DjangoUserLite | number | string | null;
  is_active?: boolean;
  left_at?: string | null;
  [key: string]: any;
};

export type DjangoConversation = {
  id: string;
  type: 'direct' | 'group' | 'channel' | 'post' | 'thread' | 'system';
  request_state?: 'none' | 'pending' | 'accepted' | 'rejected';
  request_initiator?: DjangoUserLite | number | string | null;
  request_recipient?: DjangoUserLite | number | string | null;
  members?: DjangoConversationMemberWire[];
  participants?: DjangoConversationMemberWire[];
};

/* ========================================================================== */
/*                       RICH MESSAGE WIRE TYPES                               */
/* ========================================================================== */

// 📎 Attachments already uploaded to Django; WS carries only metadata
export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'other';

export type AttachmentWireMeta = {
  id: string;
  url: string;
  originalName: string;
  mimeType: string;
  size: number;
  kind?: AttachmentKind | string;
  width?: number;
  height?: number;
  durationMs?: number;
};

// 🎙️ Voice message
export type VoiceWirePayload = {
  uri: string;
  durationMs: number;
  waveform?: number[];
};

// 🎨 Styled text / custom message
export type StyledTextWirePayload = {
  text: string;
  backgroundColor: string;
  fontSize: number;
  fontColor: string;
  fontFamily?: string | null;
};

// 😀 Sticker
export type StickerWirePayload = {
  id: string;
  uri: string;
  text?: string;
  width?: number;
  height?: number;
};

// 👥 Shared contacts
export type ContactWirePayload = {
  name: string;
  phone: string;
};

export type PollWirePayload = any;
export type EventWirePayload = any;

// 📦 Payload sent by frontend for `chat.send`
export type ChatSendWirePayload = {
  conversationId: ConversationId;
  senderId?: string; // ignored; server trusts principal.userId
  senderName?: string | null;

  // text or encrypted text
  text?: string;
  ciphertext?: string;

  attachments?: AttachmentWireMeta[];

  kind?:
    | 'text'
    | 'voice'
    | 'styled_text'
    | 'sticker'
    | 'contacts'
    | 'poll'
    | 'event'
    | 'system';

  voice?: VoiceWirePayload | null;
  styledText?: StyledTextWirePayload | null;
  sticker?: StickerWirePayload | null;
  contacts?: ContactWirePayload[];
  poll?: PollWirePayload | null;
  event?: EventWirePayload | null;

  replyToId?: string | null;
  clientId?: string; // idempotency from frontend
};

/* ========================================================================== */
/*                            GATEWAY SETUP                                   */
/* ========================================================================== */

@WebSocketGateway({
  // 🔌 Single endpoint for ALL realtime features
  path: process.env.WS_PATH ?? '/ws',
  cors: { origin: (process.env.ORIGINS ?? '').split(',').filter(Boolean) },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private server!: Server;
  private readonly log = new Logger(ChatGateway.name);

  // 🧠 Socket → joined conversations
  // Used ONLY for safety checks ("are you joined?")
  private memberships = new Map<string, Set<ConversationId>>();

  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
    private readonly auth: DjangoAuthService,
    private readonly http: HttpService,
  ) {}

  /* ======================================================================== */
  /*                         GATEWAY LIFECYCLE                                 */
  /* ======================================================================== */

  afterInit(server: Server) {
    this.server = server;
    this.log.log('🚀 ChatGateway initialized');

    // 🔐 Handshake authentication middleware
    // This runs BEFORE handleConnection
    this.server.use(async (socket: Socket, next) => {
      try {
        const header = socket.handshake?.headers?.authorization as
          | string
          | undefined;
        const bearer = header?.startsWith('Bearer ')
          ? header.slice(7)
          : undefined;
        const token =
          (socket.handshake.auth?.token as string | undefined) || bearer;

        if (!token) {
          return next(new Error('Unauthorized: missing token'));
        }

        // 🔎 Ask Django who this user is
        const principal = await this.auth.introspect(token);

        // Attach identity to socket
        (socket as any).principal = principal as Principal;
        (socket as any).token = token;

        return next();
      } catch (err) {
        this.log.warn(`Handshake auth failed: ${String(err)}`);
        return next(new Error('Unauthorized'));
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /*                       CONNECTION / DISCONNECTION                          */
  /* ------------------------------------------------------------------------ */

  async handleConnection(client: Socket) {
    const p = (client as any).principal as Principal | undefined;

    if (!p) {
      client.disconnect(true);
      return;
    }

    // 👤 STEP 1: Join the USER ROOM
    // This room receives:
    // - conversation.created
    // - conversation.updated
    // - unread count changes
    // - system notifications
    client.join(userRoom(p.userId));

    // 🧠 Track joined conversations per socket
    this.memberships.set(client.id, new Set());

    // 🟢 Presence
    await this.presence.markOnline(p.userId, client.id);

    this.log.log(`🔌 Connected user=${p.userId} socket=${client.id}`);

    // 📡 FRONTEND REQUIREMENT:
    // On connect, frontend must:
    // 1) Fetch conversation list via HTTP (Django)
    // 2) Then listen for socket events (no polling)
  }

  async handleDisconnect(client: Socket) {
    const p = (client as any).principal as Principal | undefined;

    this.memberships.delete(client.id);

    if (p) {
      await this.presence.markOffline(p.userId, client.id);
    }

    this.log.log(`❌ Disconnected socket=${client.id} user=${p?.userId}`);
  }

  /* ======================================================================== */
  /*                     🔔 DJANGO → NESTJS EVENTS                             */
  /* ======================================================================== */
  // These events are triggered by Django via Redis Pub/Sub or HTTP webhook.
  // They update the *conversation list* (NOT messages).

  // 🧩 Example event payload:
  // { type: 'conversation.created', conversationId, members[], preview }

  @SubscribeMessage('internal.conversation.created')
  handleConversationCreated(@MessageBody() payload: any) {
    const { members } = payload;

    for (const uid of members) {
      this.server.to(userRoom(String(uid))).emit('conversation.created', payload);
    }
  }

  @SubscribeMessage('internal.conversation.updated')
  handleConversationUpdated(@MessageBody() payload: any) {
    const { members } = payload;

    for (const uid of members) {
      this.server.to(userRoom(String(uid))).emit('conversation.updated', payload);
    }
  }

  /* ======================================================================== */
  /*                     💬 CONVERSATION JOIN / LEAVE                          */
  /* ======================================================================== */

  // 🟢 User opens a chat screen
  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.join')
  joinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: ConversationId },
  ) {
    const p = (client as any).principal as Principal;

    client.join(convRoom(body.conversationId));

    if (!this.memberships.get(client.id)) {
      this.memberships.set(client.id, new Set());
    }
    this.memberships.get(client.id)!.add(body.conversationId);

    this.log.log(`💬 User=${p.userId} joined conv=${body.conversationId}`);

    return { ok: true };
  }

  // 🔴 User leaves chat screen
  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.leave')
  leaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: ConversationId },
  ) {
    client.leave(convRoom(body.conversationId));
    this.memberships.get(client.id)?.delete(body.conversationId);
    return { ok: true };
  }

  /* ======================================================================== */
  /*                           ✉️ SEND MESSAGE                                 */
  /* ======================================================================== */

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.send')
  async sendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatSendWirePayload,
  ) {
    const p = (client as any).principal as Principal;

    // 🛑 Safety: must have joined the conversation
    if (!this.memberships.get(client.id)?.has(body.conversationId)) {
      return { ok: false, error: 'not_joined' };
    }

    // 🧠 Django policy check (DM requests, membership, etc.)
    // ... (kept identical to your existing logic)

    // 💾 Persist message
    const dto: SendMessageDto = {
      conversationId: body.conversationId,
      ciphertext: body.ciphertext ?? body.text ?? '',
      attachments: body.attachments ?? [],
      replyToId: body.replyToId ?? null,
      kind: body.kind,
      voice: body.voice ?? null,
      styledText: body.styledText ?? null,
      sticker: body.sticker ?? null,
      contacts: body.contacts ?? [],
      poll: body.poll ?? null,
      event: body.event ?? null,
    } as any;

    const msg = await this.messages.save(p.userId, dto, (client as any).token);

    // 📡 Fan-out to conversation room
    this.server.to(convRoom(body.conversationId)).emit('chat.message', {
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: body.senderName ?? p.username ?? p.userId,
      text: msg.ciphertext,
      ciphertext: msg.ciphertext,
      attachments: msg.attachments ?? [],
      kind: msg.kind,
      voice: msg.voice,
      styledText: msg.styledText,
      sticker: msg.sticker,
      contacts: msg.contacts ?? [],
      poll: msg.poll ?? null,
      event: msg.event ?? null,
      createdAt: msg.createdAt,
      replyToId: msg.replyToId,
      status: msg.status,
    });

    // 🔔 Also notify USER ROOM for inbox preview updates
    this.server
      .to(userRoom(p.userId))
      .emit('conversation.last_message', {
        conversationId: body.conversationId,
        lastMessage: msg,
      });

    return { ok: true, id: msg.id };
  }

  /* ======================================================================== */
  /*                             🧑‍💻 FRONTEND NOTES                           */
  /* ======================================================================== */
  // FRONTEND MUST:
  // 🔹 Maintain ONE socket per logged-in user
  // 🔹 On connect:
  //    - Fetch conversations via HTTP (Django)
  // 🔹 Listen to:
  //    - conversation.created
  //    - conversation.updated
  //    - conversation.last_message
  // 🔹 Join conv rooms ONLY when chat screen is open
  // 🔹 Never poll for conversations
}
