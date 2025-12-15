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

type Principal = {
  userId: string;
  username?: string;
  isPremium?: boolean;
  scopes?: string[];
};

type RoomId = string;
type RoomMeta = { id: RoomId; name?: string; createdAt: number };

const roomKey = (id: string) => `conv:${id}`;
const cryptoRandom = (): RoomId =>
  ('r_' +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)) as RoomId;

type DjangoUserLite = {
  id: number | string;
  [key: string]: any;
};

type DjangoConversationMemberWire = {
  id?: number | string;
  user?: DjangoUserLite | number | string | null;
  is_active?: boolean;
  left_at?: string | null;
  [key: string]: any;
};

type DjangoConversation = {
  id: string;
  type: 'direct' | 'group' | 'channel' | 'post' | 'thread' | 'system';
  request_state?: 'none' | 'pending' | 'accepted' | 'rejected';
  request_initiator?: DjangoUserLite | number | string | null;
  request_recipient?: DjangoUserLite | number | string | null;
  // from ConversationDetailSerializer (source="memberships")
  members?: DjangoConversationMemberWire[];
  // or from list serializers if you ever use "participants"
  participants?: DjangoConversationMemberWire[];
};

/* -------------------------------------------------------------------------- */
/*                             RICH CHAT PAYLOAD TYPES                        */
/* -------------------------------------------------------------------------- */

type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'other';

type AttachmentWireMeta = {
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

type VoiceWirePayload = {
  uri: string;
  durationMs: number;
  waveform?: number[];
};

type StyledTextWirePayload = {
  text: string;
  backgroundColor: string;
  fontSize: number;
  fontColor: string;
  fontFamily?: string | null;
};

type StickerWirePayload = {
  id: string;
  uri: string;
  text?: string;
  width?: number;
  height?: number;
};

type ContactWirePayload = {
  name: string;
  phone: string;
};

type PollWirePayload = any; // matches whatever PollDraft the RN client sends
type EventWirePayload = any; // matches whatever EventDraft the RN client sends

/**
 * This is the *wire* payload we expect from the client for `chat.send`.
 * It is designed to match your React Native ChatMessage structure.
 */
type ChatSendWirePayload = {
  conversationId: string;
  senderId?: string; // we do NOT trust this, we use principal.userId
  senderName?: string | null;

  // text content (client may send either `text` or `ciphertext`)
  text?: string;
  ciphertext?: string;

  // file attachments (already uploaded to /uploads/file and Django, only metadata here)
  attachments?: AttachmentWireMeta[];

  // rich content
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

  // extra rich payloads
  contacts?: ContactWirePayload[];
  poll?: PollWirePayload | null;
  event?: EventWirePayload | null;

  replyToId?: string | null;
  clientId?: string;
};

@WebSocketGateway({
  path: process.env.WS_PATH ?? '/ws',
  cors: { origin: (process.env.ORIGINS ?? '').split(',').filter(Boolean) },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private server!: Server;
  private readonly log = new Logger(ChatGateway.name);

  private rooms = new Map<RoomId, RoomMeta>();
  private memberships = new Map<string, Set<RoomId>>();

  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
    private readonly auth: DjangoAuthService,
    private readonly http: HttpService,
  ) {}

  // ---------------- Lifecycle & Handshake Auth ----------------

  afterInit(server: Server) {
    this.server = server;
    this.log.log('Gateway initialized');

    this.server.use(async (socket: Socket, next) => {
      this.log.debug(
        `Handshake middleware: socket.id=${socket.id}, headers.authorization=${socket.handshake?.headers?.authorization}`,
      );

      try {
        const header = socket?.handshake?.headers
          ?.authorization as string | undefined;
        const bearer = header?.startsWith('Bearer ')
          ? header.slice(7)
          : undefined;
        const token =
          (socket.handshake.auth?.token as string | undefined) || bearer;

        if (!token) {
          this.log.warn(
            `Handshake failed: missing token for socket ${socket.id}`,
          );
          return next(new Error('Unauthorized: missing token'));
        }

        this.log.debug(`Introspecting token for socket ${socket.id}`);
        const principal = await this.auth.introspect(token);

        this.log.debug(
          `Introspection OK for socket ${socket.id}, userId=${(principal as any).userId}`,
        );
        (socket as any).principal = principal as Principal;
        (socket as any).token = token;

        return next();
      } catch (err) {
        this.log.warn(
          `auth error for socket ${socket.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return next(new Error('Unauthorized: invalid token'));
      }
    });
  }

  async handleConnection(client: Socket) {
    const p = (client as any).principal as Principal | undefined;
    this.log.log(
      `handleConnection: socket.id=${client.id}, principal=${p ? JSON.stringify(p) : 'null'}`,
    );

    if (!p) {
      this.log.warn(`connection without principal, disconnecting ${client.id}`);
      client.disconnect(true);
      return;
    }

    this.memberships.set(client.id, new Set());
    await this.presence.markOnline(p.userId, client.id);
    this.log.log(`connected user=${p.userId} socket=${client.id}`);

    const roomsPayload = this.roomListPayload();
    this.log.debug(
      `Emitting rooms.update to socket=${client.id}, roomsCount=${roomsPayload.length}`,
    );
    client.emit('rooms.update', roomsPayload);
  }

  async handleDisconnect(client: Socket) {
    const p = (client as any).principal as Principal | undefined;
    this.log.log(
      `handleDisconnect: socket.id=${client.id}, user=${p?.userId ?? 'anon'}`,
    );

    this.memberships.delete(client.id);

    if (p) {
      await this.presence.markOffline(p.userId, client.id);
      this.log.debug(
        `Marked user=${p.userId} offline for socket=${client.id} (may still have other sockets)`,
      );
    }
  }

  private displayName(p: Principal) {
    return p.username || p.userId;
  }

  private roomListPayload() {
    const list = [...this.rooms.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    this.log.debug(`roomListPayload: count=${list.length}`);
    return list;
  }

  private broadcastRooms() {
    const payload = this.roomListPayload();
    this.log.debug(
      `broadcastRooms: broadcasting ${payload.length} rooms`,
    );
    this.server.emit('rooms.update', payload);
  }

  // ---------------- Django integration for DM request policy ----------------

  private get djangoBaseUrl() {
    const base = process.env.DJANGO_BASE_URL;
    if (!base) {
      this.log.error('DJANGO_BASE_URL env var is not set');
      throw new Error('DJANGO_BASE_URL env var is not set');
    }
    return base.replace(/\/+$/, '');
  }

  private async fetchConversationFromDjango(
    socket: Socket,
    conversationId: string,
  ): Promise<DjangoConversation | null> {
    const token = (socket as any).token as string | undefined;
    if (!token) {
      this.log.warn(
        `fetchConversationFromDjango: missing token on socket ${socket.id} for conv=${conversationId}`,
      );
      return null;
    }

    const url = `${this.djangoBaseUrl}/api/v1/conversations/${conversationId}/`;
    this.log.debug(
      `fetchConversationFromDjango: GET ${url} for socket=${socket.id}`,
    );

    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );

      this.log.debug(
        `fetchConversationFromDjango OK conv=${conversationId}, data=${JSON.stringify(
          res.data,
        )}`,
      );
      return res.data as DjangoConversation;
    } catch (err) {
      this.log.warn(
        `fetchConversationFromDjango failed for conv=${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async acceptDmRequestOnDjango(
    socket: Socket,
    conversationId: string,
  ): Promise<void> {
    const token = (socket as any).token as string | undefined;
    if (!token) {
      this.log.warn(
        `acceptDmRequestOnDjango: missing token on socket ${socket.id} for conv=${conversationId}`,
      );
      return;
    }

    const url = `${this.djangoBaseUrl}/api/chat/conversations/${conversationId}/accept-request/`;
    this.log.debug(
      `acceptDmRequestOnDjango: POST ${url} for socket=${socket.id}`,
    );

    try {
      await firstValueFrom(
        this.http.post(
          url,
          {},
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        ),
      );
      this.log.debug(
        `acceptDmRequestOnDjango OK for conv=${conversationId} (auto-accepted)`,
      );
    } catch (err) {
      this.log.warn(
        `acceptDmRequestOnDjango failed for conv=${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async canUserSendInConversation(
    socket: Socket,
    conversationId: string,
    userId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    this.log.debug(
      `canUserSendInConversation: socket=${socket.id}, userId=${userId}, conv=${conversationId}`,
    );

    const conv = await this.fetchConversationFromDjango(
      socket,
      conversationId,
    );

    if (!conv) {
      const strict = process.env.CHAT_DM_POLICY_STRICT === '1';

      if (strict) {
        this.log.debug(
          `canUserSendInConversation: conv not found / not accessible for conv=${conversationId} (STRICT mode → block)`,
        );
        return {
          ok: false,
          error: 'conversation_not_found_or_not_accessible',
        };
      }

      this.log.warn(
        `canUserSendInConversation: conv=${conversationId} not found, but STRICT mode is OFF → allowing send.`,
      );
      return { ok: true };
    }

    this.log.debug(
      `canUserSendInConversation: conv=${conversationId}, type=${conv.type}, request_state=${conv.request_state}`,
    );

    // For non-direct conversations, we don't enforce DM request policy
    if (conv.type !== 'direct') {
      this.log.debug(
        `canUserSendInConversation: conv=${conversationId} is type=${conv.type}, sending allowed (no DM lock).`,
      );
      return { ok: true };
    }

    const userIdStr = String(userId);

    // Helper: check if the user is a member in Django payload (members or participants)
    const isMemberFromDjango = (conversation: DjangoConversation, uid: string): boolean => {
      const rawMembers =
        (conversation as any).members ??
        (conversation as any).participants ??
        [];
      if (!Array.isArray(rawMembers)) return false;

      return rawMembers.some((m: DjangoConversationMemberWire) => {
        const u: any = (m as any).user ?? m;
        const memberUserId = u?.id ?? u;
        const active = (m as any).is_active !== false && !(m as any).left_at;
        return active && String(memberUserId) === uid;
      });
    };

    const isMember = isMemberFromDjango(conv, userIdStr);

    if (!isMember) {
      this.log.debug(
        `canUserSendInConversation: user=${userIdStr} is not in members[] for conv=${conversationId}`,
      );
      return { ok: false, error: 'not_participant' };
    }

    // If no request workflow → allow for direct convs as long as you are a member
    if (!conv.request_state || conv.request_state === 'none') {
      this.log.debug(
        `canUserSendInConversation: direct conv=${conversationId} with request_state=${conv.request_state}, user=${userIdStr} is member → allowed (no DM lock).`,
      );
      return { ok: true };
    }

    // Helper to normalize Django nested user or plain id
    const normalizeUserId = (val: any): string | null => {
      if (val == null) return null;
      if (typeof val === 'object' && 'id' in val) {
        return String((val as any).id);
      }
      return String(val);
    };

    const initiatorId = normalizeUserId(conv.request_initiator);
    const recipientId = normalizeUserId(conv.request_recipient);

    this.log.debug(
      `canUserSendInConversation: userId=${userIdStr}, initiator=${initiatorId}, recipient=${recipientId}`,
    );

    // 🔹 Pending DM request:
    //   - Initiator: allowed to send (UI enforces "first message only").
    //   - Recipient: sending auto-accepts the DM on Django and is allowed.
    if (conv.request_state === 'pending') {
      if (userIdStr === initiatorId) {
        this.log.debug(
          `canUserSendInConversation: initiator sending in pending conv=${conversationId} → allowed (first-message lock is UI-side).`,
        );
        return { ok: true };
      }
      if (userIdStr === recipientId) {
        this.log.debug(
          `canUserSendInConversation: recipient sending in pending conv=${conversationId}, triggering auto-accept`,
        );
        await this.acceptDmRequestOnDjango(socket, conversationId);
        return { ok: true };
      }

      this.log.debug(
        `canUserSendInConversation: user=${userIdStr} is member but not initiator/recipient in pending conv=${conversationId} → blocked.`,
      );
      return { ok: false, error: 'pending_request_sender_blocked' };
    }

    if (conv.request_state === 'accepted') {
      this.log.debug(
        `canUserSendInConversation: conv=${conversationId} accepted, user=${userIdStr} is member → sending allowed`,
      );
      return { ok: true };
    }

    if (conv.request_state === 'rejected') {
      this.log.debug(
        `canUserSendInConversation: conv=${conversationId} rejected, sending blocked`,
      );
      return { ok: false, error: 'request_rejected' };
    }

    this.log.debug(
      `canUserSendInConversation: conv=${conversationId} unknown state=${conv.request_state}, blocking`,
    );
    return { ok: false, error: 'forbidden' };
  }

  private mapPolicyErrorToMessage(code?: string): string {
    switch (code) {
      case 'pending_request_sender_blocked':
        return 'Your message was not delivered. The recipient has not accepted your chat request yet.';
      case 'request_rejected':
        return 'Your message was not delivered because the recipient rejected your chat request.';
      case 'not_participant':
        return 'You are not a participant in this conversation.';
      case 'conversation_not_found_or_not_accessible':
        return 'This conversation could not be found or you do not have access to it.';
      case 'not_joined_to_conversation':
        return 'You are not joined to this conversation.';
      default:
        return 'Your message was not delivered due to conversation restrictions.';
    }
  }

  // ---------------- Rooms (Create/List/Join/Leave) ----------------

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('room.list')
  handleListRooms(@ConnectedSocket() client: Socket) {
    this.log.debug(`room.list from socket=${client.id}`);
    client.emit('rooms.update', this.roomListPayload());
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('room.create')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId?: RoomId; name?: string },
  ) {
    const p = (client as any).principal as Principal;
    this.log.debug(
      `room.create by user=${p.userId}, socket=${client.id}, body=${JSON.stringify(
        body,
      )}`,
    );

    const rid: RoomId = (body?.roomId || cryptoRandom()) as RoomId;
    if (!this.rooms.has(rid)) {
      this.rooms.set(rid, {
        id: rid,
        name: body?.name,
        createdAt: Date.now(),
      });
      this.log.log(`room created id=${rid} by user=${p.userId}`);
    } else {
      this.log.debug(`room.create: room id=${rid} already exists`);
    }

    client.join(roomKey(rid));
    if (!this.memberships.get(client.id))
      this.memberships.set(client.id, new Set());
    this.memberships.get(client.id)!.add(rid);

    this.log.debug(
      `room.create: socket=${client.id} joined room=${rid}, membership=${JSON.stringify(
        Array.from(this.memberships.get(client.id)!),
      )}`,
    );

    client.emit('room.created', { id: rid, name: body?.name });
    this.broadcastRooms();
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    this.log.debug(
      `chat.join from socket=${client.id}, body=${JSON.stringify(body)}`,
    );

    if (!body?.conversationId) {
      this.log.warn(`chat.join: conversationId missing for socket=${client.id}`);
      return { ok: false, error: 'conversationId_required' };
    }
    const rid = body.conversationId;

    if (!this.rooms.has(rid)) {
      this.rooms.set(rid, { id: rid, createdAt: Date.now() });
      this.log.log(
        `chat.join: created in-memory room for conv=${rid} (ad-hoc / Django conv)`,
      );
      this.broadcastRooms();
    }

    client.join(roomKey(rid));
    if (!this.memberships.get(client.id))
      this.memberships.set(client.id, new Set());
    this.memberships.get(client.id)!.add(rid);

    this.log.log(`socket=${client.id} joined room=${rid}`);
    this.log.debug(
      `chat.join: memberships for socket=${client.id} => ${JSON.stringify(
        Array.from(this.memberships.get(client.id)!),
      )}`,
    );

    client.emit('chat.joined', { conversationId: rid });
    return { ok: true };
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.leave')
  leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    this.log.debug(
      `chat.leave from socket=${client.id}, body=${JSON.stringify(body)}`,
    );

    if (!body?.conversationId) {
      this.log.warn(`chat.leave: conversationId missing for socket=${client.id}`);
      return { ok: false, error: 'conversationId_required' };
    }

    client.leave(roomKey(body.conversationId));
    this.memberships.get(client.id)?.delete(body.conversationId);

    this.log.log(`socket=${client.id} left room=${body.conversationId}`);
    this.log.debug(
      `chat.leave: memberships for socket=${client.id} => ${JSON.stringify(
        Array.from(this.memberships.get(client.id) ?? []),
      )}`,
    );

    client.emit('chat.left', { conversationId: body.conversationId });
    return { ok: true };
  }

  // ---------------- Messaging ----------------

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.send')
  async send(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatSendWirePayload,
  ) {
    const p = (client as any).principal as Principal;

    // 1) RAW payload from frontend
    this.log.debug(
      `chat.send RAW body from socket=${client.id}, user=${p?.userId ?? 'unknown'}: ${JSON.stringify(
        body,
      )}`,
    );

    // 👉 EXTRA DEBUG: pretty-print full incoming body so you can see everything
    this.log.debug(
      `👉 chat.send FULL BODY DEBUG socket=${client.id}, user=${
        p?.userId ?? 'unknown'
      }:\n${JSON.stringify(body, null, 2)}`,
    );

    // Accept either `text` or `ciphertext` from client; prefer `ciphertext`
    const rawText = body.ciphertext ?? body.text ?? '';
    const trimmedCiphertext = rawText.trim();

    const hasText = !!trimmedCiphertext;
    const hasAttachments =
      Array.isArray(body.attachments) && body.attachments.length > 0;
    const hasRichContent =
      !!body.voice ||
      !!body.styledText ||
      !!body.sticker ||
      (Array.isArray(body.contacts) && body.contacts.length > 0) ||
      !!body.poll ||
      !!body.event;

    // 2) Enriched summary
    this.log.debug(
      `chat.send SUMMARY from socket=${client.id}, user=${p.userId}, dto=${JSON.stringify(
        {
          ...body,
          ciphertextPreview: hasText
            ? trimmedCiphertext.slice(0, 20) + '...'
            : null,
          attachmentsCount: body.attachments?.length ?? 0,
          hasVoice: !!body.voice,
          hasStyledText: !!body.styledText,
          hasSticker: !!body.sticker,
          contactsCount: body.contacts?.length ?? 0,
          hasPoll: !!body.poll,
          hasEvent: !!body.event,
        },
      )}`,
    );

    if (!body?.conversationId) {
      this.log.warn(
        `chat.send: missing conversationId from user=${p.userId}, socket=${client.id}`,
      );
      return { ok: false, error: 'conversationId_required' };
    }

    // allow messages that are text OR attachments OR rich content
    if (!hasText && !hasAttachments && !hasRichContent) {
      this.log.warn(
        `chat.send: empty message from user=${p.userId}, conv=${body.conversationId} (no text, no attachments, no rich content)`,
      );
      return { ok: false, error: 'empty_message' };
    }

    const joined = this.memberships.get(client.id);
    if (!joined?.has(body.conversationId)) {
      this.log.warn(
        `chat.send: user=${p.userId} socket=${client.id} tried to send to conv=${body.conversationId} but is NOT joined`,
      );
      const message = this.mapPolicyErrorToMessage(
        'not_joined_to_conversation',
      );
      client.emit('chat.system', {
        kind: 'dm_request_block',
        conversationId: body.conversationId,
        code: 'not_joined_to_conversation',
        message,
      });
      return {
        ok: false,
        error: 'not_joined_to_conversation',
        message,
      };
    }

    this.log.debug(
      `chat.send: user=${p.userId} socket=${client.id} is joined to conv=${body.conversationId}, running DM policy check`,
    );

    const policy = await this.canUserSendInConversation(
      client,
      body.conversationId,
      p.userId,
    );

    this.log.debug(
      `chat.send: policy result for user=${p.userId} conv=${body.conversationId} => ${JSON.stringify(
        policy,
      )}`,
    );

    if (!policy.ok) {
      const code = policy.error ?? 'forbidden';
      const humanMessage = this.mapPolicyErrorToMessage(code);

      this.log.warn(
        `chat.send: blocked by policy. user=${p.userId}, conv=${body.conversationId}, code=${code}, message=${humanMessage}`,
      );

      client.emit('chat.system', {
        kind: 'dm_request_block',
        conversationId: body.conversationId,
        code,
        message: humanMessage,
      });

      return {
        ok: false,
        error: code,
        message: humanMessage,
      };
    }

    this.log.debug(
      `chat.send: policy OK for user=${p.userId}, conv=${body.conversationId}. Saving message to DB...`,
    );

    // Normalize into the DTO we expect in the messages service / Mongo
    const dto: SendMessageDto & {
      clientId?: string;
      senderName?: string | null;
    } = {
      conversationId: body.conversationId,
      ciphertext: hasText ? trimmedCiphertext : '',
      attachments: body.attachments ?? [],
      replyToId: body.replyToId ?? null,
      // rich content
      kind: body.kind,
      voice: body.voice ?? null,
      styledText: body.styledText ?? null,
      sticker: body.sticker ?? null,
      contacts: body.contacts ?? [],
      poll: body.poll ?? null,
      event: body.event ?? null,
      // extra metadata
      clientId: body.clientId,
      senderName: body.senderName ?? null,
    } as any;

    // 3) Log the normalized DTO
    this.log.debug(
      `chat.send NORMALIZED DTO for Mongo. user=${p.userId}, conv=${body.conversationId}: ${JSON.stringify(
        {
          ...dto,
          ciphertextPreview: dto.ciphertext
            ? dto.ciphertext.slice(0, 20) + '...'
            : null,
        },
      )}`,
    );

    let msg;
    try {
      const userToken =
        ((client as any).token as string | undefined) ||
        // fallback (in case handshake middleware didn’t run for some reason)
        (typeof client.handshake?.auth?.token === 'string'
          ? (client.handshake.auth.token as string)
          : undefined) ||
        (typeof client.handshake?.headers?.authorization === 'string' &&
        client.handshake.headers.authorization.startsWith('Bearer ')
          ? client.handshake.headers.authorization.slice(7)
          : undefined);


          this.log.debug(
            `chat.send: token verification ${userToken}`,
          );
      msg = await this.messages.save(p.userId, dto, userToken ?? null);
    
    
    } catch (err) {
      this.log.error(
        `chat.send: error while saving message for user=${p.userId}, conv=${body.conversationId}: ${
          err instanceof Error ? err.stack || err.message : String(err)
        }`,
      );
      return { ok: false, error: 'db_error' };
    }

    this.log.debug(
      `chat.send: message saved to DB. id=${msg.id}, conv=${msg.conversationId}, sender=${msg.senderId}, createdAt=${msg.createdAt}`,
    );
    const payload = {
      id: msg.id,
      clientId: body.clientId,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: body.senderName || this.displayName(p),

      // content
      ciphertext: msg.ciphertext,
      text: msg.ciphertext, // 🔹 alias for React Native client
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

      // extra flags
      isDeleted: msg.isDeleted ?? false,
      isPinned: msg.isPinned ?? false,
      status: msg.status,

      // ✅ first-message flag for UI
      isFirstMessage: (msg as any).isFirstMessage ?? false,
    };

    this.log.debug(
      `chat.send: broadcasting chat.message to room=${roomKey(
        body.conversationId,
      )}, payloadSummary=${JSON.stringify({
        id: payload.id,
        clientId: payload.clientId,
        senderId: payload.senderId,
        conversationId: payload.conversationId,
        createdAt: payload.createdAt,
        hasText: !!payload.ciphertext,
        attachmentsCount: payload.attachments?.length ?? 0,
        hasVoice: !!payload.voice,
        hasStyledText: !!payload.styledText,
        hasSticker: !!payload.sticker,
        contactsCount: payload.contacts?.length ?? 0,
        hasPoll: !!payload.poll,
        hasEvent: !!payload.event,
      })}`,
    );

    this.server.to(roomKey(body.conversationId)).emit('chat.message', payload);

    this.log.debug(
      `chat.send: ACK success to user=${p.userId}, msgId=${msg.id}, conv=${body.conversationId}`,
    );
    return { ok: true, id: msg.id };
  }

  // ---------------- History ----------------

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.history')
  async history(
    @MessageBody() body: { conversationId: RoomId; limit?: number },
  ) {
    this.log.debug(
      `chat.history requested for conv=${body?.conversationId}`,
    );

    if (!body?.conversationId) {
      this.log.warn('chat.history: conversationId missing');
      return { ok: false, error: 'conversationId_required' };
    }

    const limit = body.limit ?? 30;
    this.log.debug(
      `chat.history: loading last ${limit} messages for conv=${body.conversationId}`,
    );

    const items = await this.messages.history(
      body.conversationId,
      limit,
    );

    this.log.debug(
      `chat.history: loaded ${items.length} messages for conv=${body.conversationId}`,
    );

    return items.map((m: any) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,

      // 🔹 include senderName (if stored in Mongo)
      senderName: m.senderName ?? null,

      ciphertext: m.ciphertext,
      text: m.ciphertext, // alias for RN client
      attachments: m.attachments ?? [],
      kind: m.kind,
      voice: m.voice,
      styledText: m.styledText,
      sticker: m.sticker,
      contacts: m.contacts ?? [],
      poll: m.poll ?? null,
      event: m.event ?? null,

      createdAt: m.createdAt,
      replyToId: m.replyToId,

      isDeleted: m.isDeleted ?? false,
      isPinned: m.isPinned ?? false,
      status: m.status,

      // 🔹 make sure first-message flag comes back in history
      isFirstMessage: m.isFirstMessage ?? false,
    }));
  }

  // ---------------- Typing ----------------

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('typing')
  typing(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { conversationId: RoomId; isTyping: boolean; senderName?: string },
  ) {
    const p = (client as any).principal as Principal;
    this.log.debug(
      `typing event from user=${p.userId}, socket=${client.id}, body=${JSON.stringify(
        body,
      )}`,
    );

    if (!body?.conversationId) {
      this.log.warn(`typing: missing conversationId from socket=${client.id}`);
      return;
    }

    client.to(roomKey(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      isTyping: !!body.isTyping,
      senderName: body.senderName || this.displayName(p),
    });
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('typing.start')
  typingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    const p = (client as any).principal as Principal;
    this.log.debug(
      `typing.start from user=${p.userId}, socket=${client.id}, body=${JSON.stringify(
        body,
      )}`,
    );

    if (!body?.conversationId) {
      this.log.warn(
        `typing.start: missing conversationId from socket=${client.id}`,
      );
      return;
    }

    client.to(roomKey(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      isTyping: true,
      senderName: this.displayName(p),
    });
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('typing.stop')
  typingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    const p = (client as any).principal as Principal;
    this.log.debug(
      `typing.stop from user=${p.userId}, socket=${client.id}, body=${JSON.stringify(
        body,
      )}`,
    );

    if (!body?.conversationId) {
      this.log.warn(
        `typing.stop: missing conversationId from socket=${client.id}`,
      );
      return;
    }

    client.to(roomKey(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      isTyping: false,
      senderName: this.displayName(p),
    });
  }
}
