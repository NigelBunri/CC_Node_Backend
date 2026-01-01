// src/realtime/handlers/calls.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface CallsDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  callsService?: {
    // optional persistence — Batch B calls note
    upsertState?: (args: { conversationId: string; state: any }) => Promise<void>
    clearState?: (args: { conversationId: string }) => Promise<void>
  }
}

export function registerCallHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  const forward = async (event: string, payload: any, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))

    try {
      await deps.rateLimitService.assert(principal, `call:${conversationId}`, 120)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      // fan out signaling (offer/answer/ice/end)
      safeEmit(server, rooms.convRoom(conversationId), event, {
        ...payload,
        fromUserId: principal.userId,
        at: new Date().toISOString(),
      })

      // optional persistence hook
      if (deps.callsService?.upsertState && (event === EVT.CALL_OFFER || event === EVT.CALL_ANSWER)) {
        await deps.callsService.upsertState({ conversationId, state: { lastEvent: event, payload } })
      }
      if (deps.callsService?.clearState && event === EVT.CALL_END) {
        await deps.callsService.clearState({ conversationId })
      }

      safeAck(ack, ok({ forwarded: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Call signaling failed', 'ERROR'))
    }
  }

  socket.on(EVT.CALL_OFFER, (payload: any, ack?: (a: Ack<any>) => void) => forward(EVT.CALL_OFFER, payload, ack))
  socket.on(EVT.CALL_ANSWER, (payload: any, ack?: (a: Ack<any>) => void) => forward(EVT.CALL_ANSWER, payload, ack))
  socket.on(EVT.CALL_ICE, (payload: any, ack?: (a: Ack<any>) => void) => forward(EVT.CALL_ICE, payload, ack))
  socket.on(EVT.CALL_END, (payload: any, ack?: (a: Ack<any>) => void) => forward(EVT.CALL_END, payload, ack))
}
