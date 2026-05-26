import type { FastifyPluginAsync } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';

import { auth } from '../../auth/index.js';
import { db } from '../../db/index.js';
import { loadCompany } from '../../lib/company-loader.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { join, roomKey } from './hub.js';

/**
 * WebSocket endpoint at /ws/chat. Connection-time handshake:
 *   1. Validate session cookie (Better Auth)
 *   2. Read query params: ?slug=... &partnerUserId=...
 *   3. For admins  → verify they have membership in the slug
 *      For partners → verify their user_id matches partnerUserId AND they
 *                    have a partners row in that brand
 *   4. Add the socket to roomKey(slug, partnerUserId)
 *   5. Bridge incoming client messages → REST-equivalent broadcasts.
 *      We deliberately keep DB writes on the REST side; the WS is a
 *      pure delivery channel for low-latency typing/presence events.
 */
const chatWsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, {
    options: {
      // ~1 MB cap — text messages are small, file uploads go via S3 presigned
      // and only the key/metadata travels through chat.
      maxPayload: 1024 * 1024,
    },
  });

  app.get('/chat', { websocket: true }, async (connection, req) => {
    // Build a WHATWG Request out of the upgrade so Better Auth can read the
    // session cookie — same trick the HTTP auth plugin uses.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      else if (v !== undefined) headers.set(k, String(v));
    }
    const session = await auth.api.getSession({ headers });
    const sessionUser = session?.user as
      | { id: string; audience?: string; isActive?: boolean }
      | undefined;
    if (!sessionUser || sessionUser.isActive === false) {
      connection.close(4401, 'Unauthorized');
      return;
    }

    const q = req.query as { slug?: string; partnerUserId?: string };
    if (!q.slug || !q.partnerUserId) {
      connection.close(4400, 'Missing slug or partnerUserId');
      return;
    }

    const company = await loadCompany(q.slug);
    if (!company) {
      connection.close(4404, 'Unknown company');
      return;
    }
    const tables = getTenantTables(company.schemaName);

    const role: 'admin' | 'partner' = sessionUser.audience === 'partner' ? 'partner' : 'admin';

    if (role === 'partner') {
      // Partners can only listen to their own conversation.
      if (sessionUser.id !== q.partnerUserId) {
        connection.close(4403, 'Partner can only subscribe to their own conversation');
        return;
      }
      const [p] = await db
        .select({ id: tables.partners.id })
        .from(tables.partners)
        .where(eq(tables.partners.userId, sessionUser.id))
        .limit(1);
      if (!p) {
        connection.close(4403, 'Not a partner of this brand');
        return;
      }
    } else {
      // Admins must be a member of the brand. Reuse the same query the HTTP
      // hook does; we can't share the hook directly because it expects a
      // Fastify request lifecycle, but the underlying check is two lines.
      const { membership, company: companyTable } = await import('../../db/schema/shared.js');
      const { and } = await import('drizzle-orm');
      const [m] = await db
        .select({ role: membership.role })
        .from(membership)
        .innerJoin(companyTable, eq(membership.companySlug, companyTable.slug))
        .where(
          and(
            eq(membership.userId, sessionUser.id),
            eq(membership.companySlug, q.slug),
            eq(companyTable.isActive, true),
          ),
        )
        .limit(1);
      // super_admin bypasses the membership check.
      const accessLevel = (sessionUser as { accessLevel?: string }).accessLevel;
      if (!m && accessLevel !== 'super_admin') {
        connection.close(4403, 'Not a member of this brand');
        return;
      }
    }

    const leave = join(roomKey(q.slug, q.partnerUserId), {
      socket: connection,
      userId: sessionUser.id,
      role,
    });

    // Send a hello frame so the client can confirm the connection is live.
    connection.send(
      JSON.stringify({
        type: 'hello',
        slug: q.slug,
        partnerUserId: q.partnerUserId,
        role,
      }),
    );

    // We don't process inbound WS frames as authoritative — REST is the
    // source of truth. But we DO accept typing pings for ultra-low-latency
    // typing indicators, broadcasting them straight through without DB.
    connection.on('message', (raw: Buffer) => {
      void (async () => {
        let parsed: { type?: string; isTyping?: boolean } | null = null;
        try {
          parsed = JSON.parse(raw.toString()) as {
            type?: string;
            isTyping?: boolean;
          };
        } catch {
          return;
        }
        if (parsed?.type === 'typing' && typeof parsed.isTyping === 'boolean') {
          const { broadcast } = await import('./hub.js');
          broadcast(
            roomKey(q.slug!, q.partnerUserId!),
            {
              type: 'typing',
              conversationId: 0, // partner doesn't know the conv id; clients ignore
              from: role,
              isTyping: parsed.isTyping,
            },
            sessionUser.id,
          );
        }
      })();
    });

    // Heartbeat — terminate dead connections so the room set doesn't grow
    // unbounded if the client disappears without a clean close.
    const interval = setInterval(() => {
      try {
        connection.ping();
      } catch {
        clearInterval(interval);
        leave();
      }
    }, 30_000);

    connection.on('close', () => {
      clearInterval(interval);
      leave();
    });
  });
};

export default chatWsPlugin;
