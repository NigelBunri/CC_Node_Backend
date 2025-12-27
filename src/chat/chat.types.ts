import { AuthPrincipal } from '../auth/django-auth.service';

export type SocketPrincipal = AuthPrincipal & {
  deviceId?: string;
};

export type ConversationPermission = {
  isMember: boolean;
  isBlocked: boolean;
  role?: 'owner' | 'admin' | 'member' | 'readonly';
  scopes?: string[];
};

export const rooms = {
  userRoom: (userId: string) => `user:${userId}`,
  convRoom: (conversationId: string) => `conv:${conversationId}`,
} as const;

export const EVT = {
  JOIN: 'chat.join',
  LEAVE: 'chat.leave',

  SEND: 'chat.send',
  EDIT: 'chat.edit',
  DELETE: 'chat.delete',
  REACT: 'chat.react',
  RECEIPT: 'chat.receipt',

  MESSAGE: 'chat.message',
  MESSAGE_EDITED: 'chat.message.edited',
  MESSAGE_DELETED: 'chat.message.deleted',
  MESSAGE_REACTION: 'chat.message.reaction',
  MESSAGE_RECEIPT: 'chat.message.receipt',

  TYPING: 'chat.typing',
  PRESENCE: 'chat.presence',

  GAP_CHECK: 'chat.gap.check',
  GAP_FILL: 'chat.gap.fill',

  CALL_OFFER: 'call.offer',
  CALL_ANSWER: 'call.answer',
  CALL_ICE: 'call.ice',
  CALL_HANGUP: 'call.hangup',
} as const;
