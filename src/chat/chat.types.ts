// src/chat/chat.types.ts

export type SocketPrincipal = {
  userId: string;
  username: string;
  isPremium: boolean;
  scopes?: string[];
  deviceId?: string;
};

export type ConversationPermission = {
  isMember: boolean;
  isBlocked?: boolean;
  dmState?: 'pending' | 'accepted' | 'rejected' | 'blocked' | 'none';
  role?: string;
  scopes?: string[];
};

export type AckOk<T> = { ok: true; data: T };
export type AckErr = { ok: false; error: { code: string; message: string; details?: any } };
export type Ack<T> = AckOk<T> | AckErr;

export type SendMessageAck = {
  clientId: string;
  serverId: string;
  seq: number;
  createdAt: string;
};

export const rooms = {
  userRoom: (userId: string) => `user:${userId}`,
  convRoom: (conversationId: string) => `conv:${conversationId}`,
  threadRoom: (conversationId: string, threadId: string) => `thread:${conversationId}:${threadId}`, // Batch B
} as const;

export const EVT = {
  // Presence / lifecycle
  PRESENCE: 'chat.presence',

  // Rooms
  JOIN: 'chat.join',
  LEAVE: 'chat.leave',

  // Messages
  SEND: 'chat.send',
  EDIT: 'chat.edit',
  DELETE: 'chat.delete',
  MESSAGE: 'chat.message',
  MESSAGE_EDITED: 'chat.message.edited',
  MESSAGE_DELETED: 'chat.message.deleted',

  // Reactions / receipts
  REACT: 'chat.react',
  MESSAGE_REACTION: 'chat.reaction',
  RECEIPT: 'chat.receipt',
  MESSAGE_RECEIPT: 'chat.receipt.event',

  // Typing
  TYPING: 'chat.typing',

  // Sync
  GAP_CHECK: 'chat.gap.check',
  GAP_FILL: 'chat.gap.fill',

  // Calls signaling (Batch A already)
  CALL_OFFER: 'chat.call.offer',
  CALL_ANSWER: 'chat.call.answer',
  CALL_ICE: 'chat.call.ice',
  CALL_HANGUP: 'chat.call.hangup',

  // ==========================
  // Batch B Events (NEW)
  // ==========================

  // Threads (subrooms)
  THREAD_JOIN: 'chat.thread.join',
  THREAD_LEAVE: 'chat.thread.leave',
  THREAD_CREATE: 'chat.thread.create',
  THREAD_MESSAGE: 'chat.thread.message',

  // Pins/Stars
  PIN_SET: 'chat.pin.set',
  STAR_SET: 'chat.star.set',

  // Search
  SEARCH_QUERY: 'chat.search.query',
  SEARCH_RESULTS: 'chat.search.results',

  // Moderation
  REPORT_MESSAGE: 'chat.mod.report',
  MOD_ACTION: 'chat.mod.action',

  // Push (server-side trigger acknowledgement)
  PUSH_ENQUEUED: 'chat.push.enqueued',

  // Call state persistence (not media)
  CALL_STATE: 'chat.call.state',
} as const;

export type MessageKind =
  | 'text'
  | 'voice'
  | 'styled_text'
  | 'sticker'
  | 'system'
  | 'contacts'
  | 'poll'
  | 'event';

// Batch B minimal payload types (kept small & stable)
export type ThreadCreatePayload = {
  conversationId: string;
  rootMessageId: string;
  title?: string;
};

export type ThreadJoinPayload = {
  conversationId: string;
  threadId: string;
};

export type PinSetPayload = {
  conversationId: string;
  messageId: string;
  pinned: boolean;
};

export type StarSetPayload = {
  conversationId: string;
  messageId: string;
  starred: boolean;
};

export type SearchQueryPayload = {
  conversationId: string;
  q: string;
  limit?: number;
};

export type ReportMessagePayload = {
  conversationId: string;
  messageId: string;
  reason: 'spam' | 'abuse' | 'harassment' | 'illegal' | 'other';
  note?: string;
};
