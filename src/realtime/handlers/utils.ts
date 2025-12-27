// src/realtime/handlers/utils.ts

import { Server, Socket } from 'socket.io';
import { EVT, rooms, SocketPrincipal } from '../../chat/chat.types';

export const convRoom = rooms.convRoom;
export const userRoom = rooms.userRoom;

export function requirePrincipal(client: Socket & { principal?: SocketPrincipal }): SocketPrincipal {
  const p = client.principal;
  if (!p?.userId) throw new Error('unauthorized');
  return p;
}

/**
 * Resolve a device id for receipts/edits/etc.
 * - Prefer principal.deviceId if provided
 * - Else fallback to socket.id for uniqueness
 */
export function resolveDeviceId(client: Socket & { principal?: SocketPrincipal }): string {
  const fromPrincipal = client.principal?.deviceId;
  return fromPrincipal && fromPrincipal.trim().length ? fromPrincipal : `socket:${client.id}`;
}

export function emitPresence(server: Server, userId: string, state: 'online' | 'offline') {
  server.emit(EVT.PRESENCE, { userId, state, at: Date.now() });
}
