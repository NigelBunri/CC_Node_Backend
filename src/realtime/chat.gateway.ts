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
  ) {}

  // ---------------- Lifecycle & Handshake Auth ----------------

  afterInit(server: Server) {
    this.server = server;
    this.log.log('Gateway initialized');

    // Handshake auth — sets socket.principal
    this.server.use(async (socket: Socket, next) => {
      try {
        const header = socket?.handshake?.headers?.authorization as string | undefined;
        const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        const token = (socket.handshake.auth?.token as string | undefined) || bearer;
        if (!token) return next(new Error('Unauthorized: missing token'));

        const principal = await this.auth.introspect(token);
        (socket as any).principal = principal;
        return next();
      } catch {
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
    if (!body?.conversationId) return { ok: false, error: 'conversationId required' };
    const rid = body.conversationId;

    // (Optional) allow ad-hoc rooms
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
    if (!body?.conversationId) return { ok: false, error: 'conversationId required' };
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
    if (!dto?.conversationId) return { ok: false, error: 'conversationId required' };

    // Only allow sending if this socket joined the room
    const joined = this.memberships.get(client.id);
    if (!joined?.has(dto.conversationId)) {
      return { ok: false, error: 'not joined to conversation' };
    }

    // Persist message (attachments supported by your MessagesService)
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
    if (!body?.conversationId) return { ok: false, error: 'conversationId required' };
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
    @MessageBody() body: { conversationId: RoomId; isTyping: boolean; senderName?: string },
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
  typingStart(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId: RoomId }) {
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
  typingStop(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId: RoomId }) {
    const p = (client as any).principal as Principal;
    if (!body?.conversationId) return;
    client.to(roomKey(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      isTyping: false,
      senderName: this.displayName(p),
    });
  }
}
