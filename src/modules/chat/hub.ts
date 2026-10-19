import type { WebSocket } from 'ws';

// In-memory pub/sub; rooms are keyed `${companySlug}:${partnerUserId}`.
// Single instance only: scaling out needs a Redis adapter or sticky sessions.

export type ChatEvent =
  | {
      type: 'message';
      conversationId: number;
      message: ChatMessagePayload;
    }
  | {
      type: 'typing';
      conversationId: number;
      from: 'admin' | 'partner';
      isTyping: boolean;
    }
  | {
      type: 'read';
      conversationId: number;
      by: 'admin' | 'partner';
      readAt: string;
    }
  | {
      type: 'delivered';
      conversationId: number;
      by: 'admin' | 'partner';
      deliveredAt: string;
    };

export interface ChatMessagePayload {
  id: number;
  conversationId: number;
  senderUserId: string;
  senderRole: 'admin' | 'partner';
  body: string | null;
  attachments: Array<{ key: string; name: string; size: number; contentType?: string }>;
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
  /** Admin endpoints only: the colleague who wrote it (null for the old system). */
  senderName?: string | null;
}

interface SocketEntry {
  socket: WebSocket;
  userId: string;
  role: 'admin' | 'partner';
}

const rooms = new Map<string, Set<SocketEntry>>();

export function roomKey(companySlug: string, partnerUserId: string): string {
  return `${companySlug}:${partnerUserId}`;
}

export function join(roomId: string, entry: SocketEntry): () => void {
  let bucket = rooms.get(roomId);
  if (!bucket) {
    bucket = new Set();
    rooms.set(roomId, bucket);
  }
  bucket.add(entry);
  return () => {
    bucket?.delete(entry);
    if (bucket && bucket.size === 0) rooms.delete(roomId);
  };
}

export function broadcast(roomId: string, event: ChatEvent, exceptUserId?: string): number {
  const bucket = rooms.get(roomId);
  if (!bucket) return 0;
  const payload = JSON.stringify(event);
  // Partners see "the team", never which colleague wrote.
  const partnerPayload =
    event.type === 'message' && event.message.senderName !== undefined
      ? JSON.stringify({ ...event, message: { ...event.message, senderName: undefined } })
      : payload;
  let n = 0;
  for (const entry of bucket) {
    if (exceptUserId && entry.userId === exceptUserId) continue;
    if (entry.socket.readyState === entry.socket.OPEN) {
      entry.socket.send(entry.role === 'partner' ? partnerPayload : payload);
      n++;
    }
  }
  return n;
}

/** True when someone with `role` has the thread open right now. */
export function hasRole(roomId: string, role: 'admin' | 'partner'): boolean {
  for (const entry of rooms.get(roomId) ?? []) {
    if (entry.role === role && entry.socket.readyState === entry.socket.OPEN) return true;
  }
  return false;
}

export function roomSize(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0;
}
