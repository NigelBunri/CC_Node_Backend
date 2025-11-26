// chat.gateway.ts
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
import { SendMessageDto } from '../messages/dto';
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
  ('r_' + Math.random().toString(36).slice(2) + Date.now().toString(36)) as RoomId;

/**
 * Expected shape from Django ConversationDetailSerializer
 * (only the fields we actually care about here).
 *
 * Adjust if your serializer changes.
 */
type DjangoConversation = {
  id: string;
  type: 'direct' | 'group' | 'channel' | 'post' | 'thread' | 'system';
  request_state?: 'none' | 'pending' | 'accepted' | 'rejected';
  request_initiator?: number | string | null;
  request_recipient?: number | string | null;
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

  /** In-memory rooms registry (swap to DB if needed). */
  private rooms = new Map<RoomId, RoomMeta>();

  /** Track socket -> joined rooms. */
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

    // Handshake auth — sets socket.principal AND preserves raw token
    this.server.use(async (socket: Socket, next) => {
      try {
        const header = socket?.handshake?.headers?.authorization as string | undefined;
        const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        const token =
          (socket.handshake.auth?.token as string | undefined) || bearer;
        if (!token) return next(new Error('Unauthorized: missing token'));

        const principal = await this.auth.introspect(token);
        (socket as any).principal = principal as Principal;
        (socket as any).token = token; // used for Django API calls
        return next();
      } catch (err) {
        this.log.warn(`auth error: ${err instanceof Error ? err.message : String(err)}`);
        return next(new Error('Unauthorized: invalid token'));
      }
    });
  }

  async handleConnection(client: Socket) {
    const p = (client as any).principal as Principal | undefined;
    if (!p) {
      this.log.warn(`connection without principal, disconnecting ${client.id}`);
      client.disconnect(true);
      return;
    }
    this.memberships.set(client.id, new Set());
    await this.presence.markOnline(p.userId, client.id);
    this.log.log(`connected user=${p.userId} socket=${client.id}`);

    // Send current rooms to the client on connect
    client.emit('rooms.update', this.roomListPayload());
  }

  async handleDisconnect(client: Socket) {
    const p = (client as any).principal as Principal | undefined;
    this.memberships.delete(client.id);
    if (p) await this.presence.markOffline(p.userId, client.id);
    this.log.log(`disconnected user=${p?.userId ?? 'anon'} socket=${client.id}`);
  }

  private displayName(p: Principal) {
    return p.username || p.userId;
  }

  private roomListPayload() {
    return [...this.rooms.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private broadcastRooms() {
    this.server.emit('rooms.update', this.roomListPayload());
  }

  // ---------------- Django integration for DM request policy ----------------

  private get djangoBaseUrl() {
    const base = process.env.DJANGO_BASE_URL;
    if (!base) {
      throw new Error('DJANGO_BASE_URL env var is not set');
    }
    return base.replace(/\/+$/, ''); // trim trailing slash
  }

  /**
   * Fetch a conversation from Django using the current user's JWT,
   * so Django will check membership and permissions for us.
   */
  private async fetchConversationFromDjango(
    socket: Socket,
    conversationId: string,
  ): Promise<DjangoConversation | null> {
    const token = (socket as any).token as string | undefined;
    if (!token) {
      this.log.warn('fetchConversationFromDjango: missing token on socket');
      return null;
    }

    const url = `${this.djangoBaseUrl}/api/chat/conversations/${conversationId}/`;
    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
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

  /**
   * Auto-accepts a pending DM request when the recipient sends a message,
   * by calling the Django `accept-request` action.
   */
  private async acceptDmRequestOnDjango(
    socket: Socket,
    conversationId: string,
  ): Promise<void> {
    const token = (socket as any).token as string | undefined;
    if (!token) return;

    const url = `${this.djangoBaseUrl}/api/chat/conversations/${conversationId}/accept-request/`;
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
    } catch (err) {
      this.log.warn(
        `acceptDmRequestOnDjango failed for conv=${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Enforce the DM request rules:
   *
   * - Non-direct or request_state NONE/ACCEPTED → allowed.
   * - PENDING:
   *    - Initiator: BLOCK (they already sent first message).
   *    - Recipient: allowed, and we auto-accept on Django.
   * - REJECTED: BLOCK.
   */
  private async canUserSendInConversation(
    socket: Socket,
    conversationId: string,
    userId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const conv = await this.fetchConversationFromDjango(socket, conversationId);
    if (!conv) {
      return { ok: false, error: 'conversation_not_found_or_not_accessible' };
    }

    // Normal groups/channels, or no request workflow
    if (conv.type !== 'direct' || !conv.request_state || conv.request_state === 'none') {
      return { ok: true };
    }

    const initiatorId = conv.request_initiator != null ? String(conv.request_initiator) : null;
    const recipientId = conv.request_recipient != null ? String(conv.request_recipient) : null;
    const userIdStr = String(userId);

    // If user is not initiator or recipient, block.
    if (userIdStr !== initiatorId && userIdStr !== recipientId) {
      return { ok: false, error: 'not_participant' };
    }

    if (conv.request_state === 'pending') {
      if (userIdStr === initiatorId) {
        // Sender already used their "first message"; further sends are blocked
        return { ok: false, error: 'pending_request_sender_blocked' };
      }
      if (userIdStr === recipientId) {
        // Recipient sending → treat as auto-accept
        await this.acceptDmRequestOnDjango(socket, conversationId);
        return { ok: true };
      }
    }

    if (conv.request_state === 'accepted') {
      return { ok: true };
    }

    if (conv.request_state === 'rejected') {
      return { ok: false, error: 'request_rejected' };
    }

    // Fallback: be safe and block
    return { ok: false, error: 'forbidden' };
  }

  /**
   * Map internal policy error codes to user-friendly messages
   * that we send back to the sender as a system notice.
   */
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
    client.emit('rooms.update', this.roomListPayload());
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('room.create')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId?: RoomId; name?: string },
  ) {
    const p = (client as any).principal as Principal;

    const rid: RoomId = (body?.roomId || cryptoRandom()) as RoomId;
    if (!this.rooms.has(rid)) {
      this.rooms.set(rid, { id: rid, name: body?.name, createdAt: Date.now() });
      this.log.log(`room created id=${rid} by user=${p.userId}`);
    }

    // Auto-join creator
    client.join(roomKey(rid));
    if (!this.memberships.get(client.id)) this.memberships.set(client.id, new Set());
    this.memberships.get(client.id)!.add(rid);

    client.emit('room.created', { id: rid, name: body?.name });
    this.broadcastRooms();
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    if (!body?.conversationId) {
      return { ok: false, error: 'conversationId_required' };
    }
    const rid = body.conversationId;

    // Optional: allow ad-hoc rooms
    if (!this.rooms.has(rid)) {
      this.rooms.set(rid, { id: rid, createdAt: Date.now() });
      this.broadcastRooms();
    }

    client.join(roomKey(rid));
    if (!this.memberships.get(client.id)) this.memberships.set(client.id, new Set());
    this.memberships.get(client.id)!.add(rid);

    this.log.log(`socket=${client.id} joined room=${rid}`);
    client.emit('chat.joined', { conversationId: rid });
    return { ok: true };
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.leave')
  leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    if (!body?.conversationId) {
      return { ok: false, error: 'conversationId_required' };
    }
    client.leave(roomKey(body.conversationId));
    this.memberships.get(client.id)?.delete(body.conversationId);

    this.log.log(`socket=${client.id} left room=${body.conversationId}`);
    client.emit('chat.left', { conversationId: body.conversationId });
    return { ok: true };
  }

  // ---------------- Messaging ----------------

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.send')
  async send(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendMessageDto & { clientId?: string; senderName?: string },
  ) {
    const p = (client as any).principal as Principal;
    if (!dto?.conversationId) {
      return { ok: false, error: 'conversationId_required' };
    }

    // Only allow sending if this socket joined the room
    const joined = this.memberships.get(client.id);
    if (!joined?.has(dto.conversationId)) {
      return { ok: false, error: 'not_joined_to_conversation' };
    }

    // DM request / lock policy check via Django
    const policy = await this.canUserSendInConversation(
      client,
      dto.conversationId,
      p.userId,
    );

    if (!policy.ok) {
      const code = policy.error ?? 'forbidden';
      const humanMessage = this.mapPolicyErrorToMessage(code);

      // 🔔 Send a "system" event back to the SENDER ONLY
      client.emit('chat.system', {
        kind: 'dm_request_block',
        conversationId: dto.conversationId,
        code,
        message: humanMessage,
      });

      // Ack with detailed info for client logic
      return {
        ok: false,
        error: code,
        message: humanMessage,
      };
    }

    // ✅ Allowed → Persist message to Mongo via MessagesService
    const msg = await this.messages.save(p.userId, dto);

    // Broadcast to the room (with clientId & senderName to help client dedupe & styling)
    const payload = {
      id: msg.id,
      clientId: dto.clientId,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: dto.senderName || this.displayName(p),
      ciphertext: msg.ciphertext,
      attachments: msg.attachments ?? [],
      createdAt: msg.createdAt,
      replyToId: msg.replyToId,
    };

    this.server.to(roomKey(dto.conversationId)).emit('chat.message', payload);
    return { ok: true, id: msg.id };
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('chat.history')
  async history(@MessageBody() body: { conversationId: RoomId; limit?: number }) {
    if (!body?.conversationId) {
      return { ok: false, error: 'conversationId_required' };
    }
    const items = await this.messages.history(body.conversationId, body.limit ?? 30);
    return items.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      ciphertext: m.ciphertext,
      createdAt: m.createdAt,
      replyToId: m.replyToId,
      attachments: m.attachments ?? [],
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
    if (!body?.conversationId) return;

    // Emit to others in the room only
    client.to(roomKey(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      isTyping: !!body.isTyping,
      senderName: body.senderName || this.displayName(p),
    });
  }

  // Back-compat → unified 'typing'
  @UseGuards(WsAuthGuard)
  @SubscribeMessage('typing.start')
  typingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: RoomId },
  ) {
    const p = (client as any).principal as Principal;
    if (!body?.conversationId) return;
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
    if (!body?.conversationId) return;
    client.to(roomKey(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      isTyping: false,
      senderName: this.displayName(p),
    });
  }
}
