import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auth } from './index.js';

type Audience = 'admin' | 'partner' | 'customer';
type AccessLevel = 'super_admin' | 'admin' | 'manager' | 'viewer' | 'none';

// Convert Fastify req/headers into a WHATWG Request for Better Auth.
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
  // Handle Set-Cookie specially: WHATWG Headers combines multiple Set-Cookie
  // headers into a single comma-joined string in forEach/get(), which is wrong
  // for cookies (commas are valid inside cookie values). getSetCookie() returns
  // each cookie as a separate entry; we forward all of them via the raw header.
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
  // Mount Better Auth handler at /auth/* (matches basePath in src/auth/index.ts).
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/auth/*',
    handler: async (request, reply) => {
      const response = await auth.handler(toWebRequest(request));
      await pipeWebResponse(reply, response);
    },
  });

  // Decorate request with session/user (populated lazily on guarded routes).
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

  // Every branch returns after reply.send() — Fastify lifecycle is safe even
  // without `return` (nothing runs after .send() here), but the explicit
  // return is defensive against future additions to these handlers.
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

  app.decorate(
    'requireAccess',
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
      },
  );
};

export default fp(authPlugin, { name: 'auth-plugin' });
