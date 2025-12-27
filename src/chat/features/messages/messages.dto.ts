// src/chat/features/messages/messages.dto.ts

import { MessageKind } from "src/chat/features/messages/schemas/message.schema";

export type SendPayload = {
  conversationId: string;
  clientId: string;
  kind: MessageKind;

  // E2EE friendly
  ciphertext?: string;
  encryptionMeta?: Record<string, any>;

  // Non-E2EE fallback
  text?: string;

  attachments?: Array<{
    id: string;
    type: string;
    mime?: string;
    name?: string;
    size?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    sha256?: string;
    thumbnailId?: string;
    extra?: Record<string, any>;
  }>;

  reply?: {
    toMessageId?: string;
    toSeq?: number;
    toUserId?: string;
    previewText?: string;
  };

  forward?: {
    isForwarded?: boolean;
    forwardCount?: number;
    originalMessageId?: string;
    originalConversationId?: string;
  };

  mentions?: { userIds?: string[] };

  ephemeral?: {
    enabled?: boolean;
    ttlSeconds?: number;
    startAfterRead?: boolean;
  };

  linkPreview?: {
    url?: string;
    title?: string;
    description?: string;
    imageUrl?: string;
  };

  poll?: {
    question?: string;
    options?: string[];
    multiple?: boolean;
  };
};

export type EditPayload = {
  conversationId: string;
  messageId: string;
  ciphertext?: string;
  encryptionMeta?: Record<string, any>;
  text?: string;
  attachments?: SendPayload['attachments'];
};

export type DeletePayload = {
  conversationId: string;
  messageId: string;
  mode: 'deleted_for_me' | 'deleted_for_everyone';
};
