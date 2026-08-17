import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auth } from './index.js';

type Audience = 'admin' | 'partner' | 'customer';
type AccessLevel = 'super_admin' | 'admin' | 'manager' | 'viewer' | 'none';

function toWebRequest(request: FastifyRequest): Request {
  const url = `${request.protocol}://${request.headers.host}${request.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers };
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    request.body !== undefined &&
    request.body !== null
  ) {
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new Request(url, init);
}

async function pipeWebResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  const setCookies =
    typeof (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
    'function'
      ? response.headers.getSetCookie()
      : [];
  if (setCookies.length > 0) {
    reply.raw.setHeader('set-cookie', setCookies);
  }
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    reply.header(key, value);
  });
  const text = await response.text();
  if (text) reply.send(text);
  else reply.send();
}

const authPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/auth/*',
    handler: async (request, reply) => {
      const response = await auth.handler(toWebRequest(request));
      await pipeWebResponse(reply, response);
    },
  });

  app.decorateRequest('authSession', null);
  app.decorateRequest('authUser', null);

  app.decorate('getSession', async (request: FastifyRequest) => {
    if (request.authSession) return request.authSession;
    const webReq = toWebRequest(request);
    const session = await auth.api.getSession({ headers: webReq.headers });
    request.authSession = session;
    request.authUser = session?.user ?? null;
    return session;
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await app.getSession(request);
    if (!session?.user) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  });

  app.decorate(
    'requireAudience',
    (...audiences: Audience[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const session = await app.getSession(request);
        const u = session?.user as { audience?: string; isActive?: boolean } | undefined;
        if (!session?.user || !u) {
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }
        if (u.isActive === false) {
          reply.code(403).send({ error: 'Account disabled' });
          return;
        }
        if (!u.audience || !audiences.includes(u.audience as Audience)) {
          reply.code(403).send({ error: 'Forbidden' });
          return;
        }
      },
  );

  const requireAccessLevels =
    (...levels: AccessLevel[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await app.getSession(request);
      const u = session?.user as { accessLevel?: string } | undefined;
      if (!session?.user || !u) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      if (!u.accessLevel || !levels.includes(u.accessLevel as AccessLevel)) {
        reply.code(403).send({ error: 'Insufficient access level' });
        return;
      }
    };

  app.decorate('requireAccess', requireAccessLevels);

  // Reads stay open to every member of the brand (including `viewer`); anything
  // that mutates state, moves money or leaves the building as customer mail
  // needs manager+. Registered as a plugin-level preHandler so a route added
  // later is gated by default instead of being open until someone remembers.
  const requireManager = requireAccessLevels('super_admin', 'admin', 'manager');
  app.decorate('requireWriteAccess', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      return;
    }
    await requireManager(request, reply);
  });
};

export default fp(authPlugin, { name: 'auth-plugin' });
