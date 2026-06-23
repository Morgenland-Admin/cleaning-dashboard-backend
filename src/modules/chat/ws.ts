import type { FastifyPluginAsync } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';

import { auth } from '../../auth/index.js';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { loadCompany } from '../../lib/company-loader.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { join, roomKey } from './hub.js';

const chatWsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });

  app.get('/chat', { websocket: true }, async (connection, req) => {
    // CSWSH guard: browsers always send Origin on the WS handshake, and SOP does
    // not block cross-origin WS the way it does fetch — so reject any browser
    // origin not in our CORS allowlist. A missing Origin (non-browser) is allowed,
    // matching the HTTP CORS policy.
    const origin = req.headers.origin;
    if (origin && !env.CORS_ORIGINS.includes(origin)) {
      connection.close(4403, 'Origin not allowed');
      return;
    }

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

    connection.send(
      JSON.stringify({
        type: 'hello',
        slug: q.slug,
        partnerUserId: q.partnerUserId,
        role,
      }),
    );

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
              conversationId: 0,
              from: role,
              isTyping: parsed.isTyping,
            },
            sessionUser.id,
          );
        }
      })();
    });

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
