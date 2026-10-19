import type { preHandlerHookHandler } from 'fastify';
import type { CompanyContext } from '../plugins/company-context.js';
import type { AuthSession } from '../auth/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    authSession: AuthSession | null;
    authUser: NonNullable<AuthSession>['user'] | null;
    company: CompanyContext | null;
  }

  interface FastifyInstance {
    getSession(request: FastifyRequest): Promise<AuthSession>;
    requireAuth: preHandlerHookHandler;
    requireAudience(...audiences: Array<'admin' | 'partner' | 'customer'>): preHandlerHookHandler;
    requireAccess(
      ...levels: Array<'super_admin' | 'admin' | 'manager' | 'seo' | 'viewer' | 'none'>
    ): preHandlerHookHandler;
    /** Plugin-level gate: GET/HEAD/OPTIONS pass, every other method needs manager+. */
    requireWriteAccess: preHandlerHookHandler;
    resolveCompanyPublic: preHandlerHookHandler;
    requireCompany: preHandlerHookHandler;
    refreshCorsOrigins(): Promise<void>;
  }
}
