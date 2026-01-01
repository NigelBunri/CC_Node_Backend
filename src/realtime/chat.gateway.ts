// src/realtime/chat.gateway.ts

import { Logger, UseGuards } from '@nestjs/common'
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'

import { WsAuthGuard } from '../auth/ws-auth.guard'
import { DjangoAuthService } from '../auth/django-auth.service'
import { EVT, rooms, type SocketPrincipal } from '../chat/chat.types'

import { DjangoConversationClient } from '../chat/integrations/django/django-conversation.client'
import { DjangoSeqClient } from '../chat/integrations/django/django-seq.client'
import { RateLimitService } from '../chat/infra/rate-limit/rate-limit.service'

import { MessagesService } from '../chat/features/messages/messages.service'
import { ReactionsService } from '../chat/features/reactions/reactions.service'
import { ReceiptsService } from '../chat/features/receipts/receipts.service'
import { SyncService } from '../chat/features/sync/sync.service'
import { CallsService } from '../chat/features/calls/calls.service'
import { ModerationService } from '../chat/features/moderation/moderation.service'
import { PresenceService } from '../chat/features/presence/presence.service'
import { registerRealtimeHandlers } from './handlers'

@WebSocketGateway({
  path: '/ws',
  cors: { origin: true, credentials: true },
})
@UseGuards(WsAuthGuard)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server

  private readonly logger = new Logger(ChatGateway.name)

  constructor(
    private readonly djangoConversationClient: DjangoConversationClient,
    private readonly djangoSeqClient: DjangoSeqClient,
    private readonly rateLimitService: RateLimitService,
    private readonly messagesService: MessagesService,
    private readonly reactionsService: ReactionsService,
    private readonly receiptsService: ReceiptsService,
    private readonly syncService: SyncService,
    private readonly callsService: CallsService,
    private readonly moderationService: ModerationService,
    private readonly presenceService: PresenceService,
    private readonly authService: DjangoAuthService,
  ) {}

  async handleConnection(@ConnectedSocket() socket: Socket) {
    let principal = (socket as any).principal as SocketPrincipal | undefined
    if (!principal?.userId) {
      const fromHeader = socket?.handshake?.headers?.authorization
      const bearer = typeof fromHeader === 'string' && fromHeader.startsWith('Bearer ') ? fromHeader.slice(7) : undefined
      const token: string | undefined = socket?.handshake?.auth?.token || bearer

      if (!token) {
        this.logger.warn(`[WS] missing token, disconnecting socketId=${socket.id}`)
        try {
          socket.disconnect(true)
        } catch {}
        return
      }

      try {
        principal = await this.authService.introspect(token)
        const deviceId = socket?.handshake?.auth?.deviceId || socket?.handshake?.headers?.['x-device-id']
        ;(socket as any).principal = { ...principal, token, deviceId }
      } catch {
        this.logger.warn(`[WS] invalid token, disconnecting socketId=${socket.id}`)
        try {
          socket.disconnect(true)
        } catch {}
        return
      }
    }

    try {
      socket.join(rooms.userRoom(principal.userId))
    } catch {}

    await this.presenceService.markOnline(principal.userId)

    this.logger.log(
      `[WS] connected socketId=${socket.id} userId=${principal.userId} deviceId=${principal.deviceId ?? '-'} ip=${socket.handshake.address ?? '-'} transport=${socket.conn.transport.name}`,
    )

    registerRealtimeHandlers(this.server, socket, {
      djangoConversationClient: this.djangoConversationClient,
      djangoSeqClient: this.djangoSeqClient,
      rateLimitService: this.rateLimitService,
      messagesService: this.messagesService,
      reactionsService: this.reactionsService,
      receiptsService: this.receiptsService,
      syncService: this.syncService,
      callsService: this.callsService,
      moderationService: this.moderationService,
    })
  }

  async handleDisconnect(@ConnectedSocket() socket: Socket) {
    try {
      socket.removeAllListeners()
    } catch {}
    const principal = (socket as any).principal as SocketPrincipal | undefined
    if (principal?.userId) {
      await this.presenceService.markOffline(principal.userId)
      for (const room of socket.rooms) {
        if (!room.startsWith('conv:')) continue
        const conversationId = room.slice('conv:'.length)
        try {
          this.server.to(room).emit(EVT.PRESENCE, {
            conversationId,
            userId: principal.userId,
            isOnline: false,
            at: new Date().toISOString(),
          })
        } catch {}
      }
      this.logger.log(
        `[WS] disconnected socketId=${socket.id} userId=${principal.userId} deviceId=${principal.deviceId ?? '-'} ip=${socket.handshake.address ?? '-'} transport=${socket.conn.transport.name}`,
      )
    } else {
      this.logger.log(`[WS] disconnected socketId=${socket.id} ip=${socket.handshake.address ?? '-'}`)
    }
  }
}
