// src/chat/integrations/django/django-conversation.client.ts

import { Injectable, UnauthorizedException } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { firstValueFrom } from 'rxjs'
import { SocketPrincipal, ConversationPermission } from '../../chat.types'

export interface DjangoWsPermsResponse {
  isMember: boolean
  isBlocked: boolean
  role?: string
  scopes?: ConversationPermission[]
}

export interface DjangoMemberIdsResponse {
  user_ids?: string[]
  userIds?: string[]
}

@Injectable()
export class DjangoConversationClient {
  constructor(private readonly http: HttpService) {}

  /**
   * Fetch conversation-scoped permissions from Django
   *
   * Django endpoint:
   *   GET /api/v1/chat/conversations/{conversationId}/ws-perms/
   *
   * Headers:
   *   Authorization: Bearer <JWT>
   *   X-Internal-Auth: <DJANGO_INTERNAL_TOKEN>
   */
  async wsPerms(
    principal: SocketPrincipal,
    conversationId: string,
  ): Promise<DjangoWsPermsResponse> {
    const url = process.env.DJANGO_CONV_PERMS_URL?.replace(
      '{conversationId}',
      conversationId,
    )

    if (!url) {
      throw new Error('DJANGO_CONV_PERMS_URL is not configured')
    }

    const headers: Record<string, string> = {
      'X-Internal-Auth': process.env.DJANGO_INTERNAL_TOKEN ?? '',
    }
    if (principal.token) {
      headers.Authorization = `Bearer ${principal.token}`
    }

    try {
      const res = await firstValueFrom(
        this.http.get<DjangoWsPermsResponse>(url, {
          headers,
          params: { userId: principal.userId },
        }),
      )

      return res.data
    } catch (err) {
      throw new UnauthorizedException('Conversation permission check failed')
    }
  }

  /**
   * Convenience guard:
   * - must be member
   * - must not be blocked
   */
  async assertMember(
    principal: SocketPrincipal,
    conversationId: string,
  ): Promise<DjangoWsPermsResponse> {
    const perms = await this.wsPerms(principal, conversationId)

    if (!perms.isMember) {
      throw new UnauthorizedException('Not a conversation member')
    }

    if (perms.isBlocked) {
      throw new UnauthorizedException('Conversation is blocked')
    }

    return perms
  }

  async updateLastMessage(args: { conversationId: string; createdAt: Date; preview?: string }) {
    const base = process.env.DJANGO_API_URL
    const url =
      process.env.DJANGO_CONV_UPDATE_LAST_MESSAGE_URL
      ?? (base ? `${base}/chat/conversations/${args.conversationId}/update-last-message/` : undefined)

    if (!url) return

    await firstValueFrom(
      this.http.patch(
        url,
        {
          last_message_at: args.createdAt.toISOString(),
          last_message_preview: (args.preview ?? '').slice(0, 255),
        },
        {
          headers: {
            'X-Internal-Auth': process.env.DJANGO_INTERNAL_TOKEN ?? '',
          },
        },
      ),
    )
  }

  async listMemberIds(conversationId: string): Promise<string[]> {
    const base = process.env.DJANGO_API_URL
    const url =
      process.env.DJANGO_CONV_MEMBER_IDS_URL
      ?? (base ? `${base}/chat/conversations/${conversationId}/member-ids/` : undefined)

    if (!url) return []

    const res = await firstValueFrom(
      this.http.get<DjangoMemberIdsResponse>(url, {
        headers: {
          'X-Internal-Auth': process.env.DJANGO_INTERNAL_TOKEN ?? '',
        },
      }),
    )

    const data = res?.data ?? {}
    return (data.user_ids ?? data.userIds ?? []).map((id) => String(id))
  }
}
