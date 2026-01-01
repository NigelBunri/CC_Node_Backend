// src/realtime/handlers/messages.ts

import type { Server, Socket } from 'socket.io'
import {
  EVT,
  rooms,
  type Ack,
  type HistoryPayload,
  type SendMessageAck,
  type SendMessagePayload,
  type EditMessagePayload,
  type SocketPrincipal,
} from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface MessagesDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
    updateLastMessage(args: { conversationId: string; createdAt: Date; preview?: string }): Promise<void>
  }
  moderationService?: {
    assertAllowed(args: {
      conversationId: string
      userId: string
      action: 'send' | 'edit' | 'delete'
    }): Promise<void> | void
  }
  djangoSeqClient: {
    allocateSeq(conversationId: string): Promise<number>
    // compatibility alias if your client uses allocate()
    allocate?: (conversationId: string) => Promise<number>
  }
  messagesService: {
    // idempotent create with rich payload
    createIdempotent(args: {
      senderId: string
      senderDeviceId?: string
      conversationId: string
      clientId: string
      seq: number
      input: SendMessagePayload
    }): Promise<{
      id: string
      seq: number
      createdAt: Date
      dto: any
    }>

    editMessage(args: {
      senderId: string
      conversationId: string
      messageId: string
      input: EditMessagePayload
    }): Promise<any>

    deleteMessage(args: {
      senderId: string
      conversationId: string
      messageId: string
    }): Promise<any>

    listRecent(args: {
      conversationId: string
      limit?: number
      before?: string
      after?: string
    }): Promise<any[]>
  }
}

export function registerMessageHandlers(server: Server, socket: Socket, deps: MessagesDeps) {
  socket.on(EVT.SEND, async (payload: SendMessagePayload, ack?: (a: Ack<{ ack: SendMessageAck }>) => void) => {
    const principal = getPrincipal(socket)

    const conversationId = payload?.conversationId
    const clientId = payload?.clientId

    if (!conversationId || !clientId) {
      return safeAck(ack, err('conversationId and clientId are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `send:${conversationId}`, 50)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (deps.moderationService) {
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'send',
        })
      }

      const allocate = deps.djangoSeqClient.allocateSeq ?? deps.djangoSeqClient.allocate
      if (!allocate) throw new Error('Seq allocator not configured')

      const seq = await allocate(conversationId)

      const created = await deps.messagesService.createIdempotent({
        senderId: principal.userId,
        senderDeviceId: principal.deviceId,
        conversationId,
        clientId,
        seq,
        input: payload,
      })

      try {
        const preview = created.dto?.previewText ?? created.dto?.text ?? payload?.text
        await deps.djangoConversationClient.updateLastMessage({
          conversationId,
          createdAt: created.createdAt,
          preview,
        })
      } catch {}

      // Fan-out to the conversation room
      safeEmit(server, rooms.convRoom(conversationId), EVT.MESSAGE, created.dto)

      const ackPayload: SendMessageAck = {
        clientId,
        serverId: created.id,
        seq: created.seq,
        createdAt: created.createdAt.toISOString(),
      }

      safeAck(ack, ok({ ack: ackPayload }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Send failed', 'ERROR'))
    }
  })

  socket.on(EVT.EDIT, async (payload: EditMessagePayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId
    const messageId = payload?.messageId

    if (!conversationId || !messageId) {
      return safeAck(ack, err('conversationId and messageId are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `edit:${conversationId}`, 60)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (deps.moderationService) {
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'edit',
        })
      }

      const updated = await deps.messagesService.editMessage({
        senderId: principal.userId,
        conversationId,
        messageId,
        input: payload,
      })

      safeEmit(server, rooms.convRoom(conversationId), EVT.EDIT, updated)
      safeAck(ack, ok({ updated: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Edit failed', 'ERROR'))
    }
  })

  socket.on(EVT.DELETE, async (payload: { conversationId: string; messageId: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId
    const messageId = payload?.messageId

    if (!conversationId || !messageId) {
      return safeAck(ack, err('conversationId and messageId are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `delete:${conversationId}`, 60)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (deps.moderationService) {
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'delete',
        })
      }

      const deleted = await deps.messagesService.deleteMessage({
        senderId: principal.userId,
        conversationId,
        messageId,
      })

      safeEmit(server, rooms.convRoom(conversationId), EVT.DELETE, deleted)
      safeAck(ack, ok({ deleted: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Delete failed', 'ERROR'))
    }
  })

  socket.on(EVT.HISTORY, async (payload: HistoryPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) {
      return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `history:${conversationId}`, 30)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      const items = await deps.messagesService.listRecent({
        conversationId,
        limit: payload?.limit,
        before: payload?.before,
        after: payload?.after,
      })

      safeAck(ack, ok({ messages: items }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'History failed', 'ERROR'))
    }
  })
}
