import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WebSocket } from 'ws';

import { broadcast, join, roomKey } from './hub.js';

function fakeSocket() {
  const sent: unknown[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  } as unknown as WebSocket;
  return { socket, sent };
}

describe('broadcast', () => {
  it('hides the admin colleague name from partner sockets', () => {
    const room = roomKey('hub-test', 'partner-1');
    const admin = fakeSocket();
    const partner = fakeSocket();
    const leaveAdmin = join(room, { socket: admin.socket, userId: 'admin-2', role: 'admin' });
    const leavePartner = join(room, {
      socket: partner.socket,
      userId: 'partner-1',
      role: 'partner',
    });
    try {
      const n = broadcast(
        room,
        {
          type: 'message',
          conversationId: 1,
          message: {
            id: 1,
            conversationId: 1,
            senderUserId: 'admin-1',
            senderRole: 'admin',
            body: 'Hallo',
            attachments: [],
            deliveredAt: null,
            readAt: null,
            createdAt: '2026-10-30T10:00:00.000Z',
            senderName: 'Erika Muster',
          },
        },
        'admin-1',
      );
      assert.equal(n, 2);
      const forAdmin = admin.sent[0] as { message: { senderName?: string } };
      const forPartner = partner.sent[0] as { message: Record<string, unknown> };
      assert.equal(forAdmin.message.senderName, 'Erika Muster');
      assert.equal('senderName' in forPartner.message, false);
      assert.equal(forPartner.message.body, 'Hallo');
    } finally {
      leaveAdmin();
      leavePartner();
    }
  });

  it('skips the sender and closed sockets', () => {
    const room = roomKey('hub-test', 'partner-2');
    const self = fakeSocket();
    const closed = fakeSocket();
    (closed.socket as unknown as { readyState: number }).readyState = 3;
    const leaveSelf = join(room, { socket: self.socket, userId: 'partner-2', role: 'partner' });
    const leaveClosed = join(room, { socket: closed.socket, userId: 'admin-1', role: 'admin' });
    try {
      const n = broadcast(
        room,
        { type: 'typing', conversationId: 0, from: 'partner', isTyping: true },
        'partner-2',
      );
      assert.equal(n, 0);
      assert.equal(self.sent.length + closed.sent.length, 0);
    } finally {
      leaveSelf();
      leaveClosed();
    }
  });
});
