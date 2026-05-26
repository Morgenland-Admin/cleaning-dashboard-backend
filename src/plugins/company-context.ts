import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { and, eq } from 'drizzle-orm';
import { isValidCompanySlug, type CompanySlug } from '../config/companies.js';
import { db } from '../db/index.js';
import { membership } from '../db/schema/shared.js';
import { getTenantTables, type TenantTables } from '../db/schema/tenant.js';
import { loadCompany } from '../lib/company-loader.js';

export interface CompanyContext {
  slug: CompanySlug;
  name: string;
  schema: string;
  /** S3 top-level folder for this brand. */
  keyPrefix: string;
  tables: TenantTables;
}

function readSlug(request: FastifyRequest): string | null {
  const headerSlug = request.headers['x-company-slug'];
  const candidate = Array.isArray(headerSlug) ? headerSlug[0] : headerSlug;
  if (candidate && isValidCompanySlug(candidate)) return candidate;
  const sessionSlug = (request.authSession?.session as { activeCompanySlug?: string } | undefined)
    ?.activeCompanySlug;
  if (sessionSlug && isValidCompanySlug(sessionSlug)) return sessionSlug;
  return null;
}

const companyContext: FastifyPluginAsync = async (app) => {
  app.decorateRequest('company', null);

  // Public resolver — non-authed routes (storefront newsletter/contact submits) call this.
  // Requires X-Company-Slug header pointing at a known active company.
  app.decorate('resolveCompanyPublic', async (request: FastifyRequest, reply: FastifyReply) => {
    const slug = readSlug(request);
    if (!slug) {
      reply.code(400).send({ error: 'Missing or invalid X-Company-Slug header' });
      return;
    }
    const row = await loadCompany(slug);
    if (!row || !row.isActive) {
      reply.code(400).send({ error: 'Unknown company slug' });
      return;
    }
    request.company = {
      slug: row.slug,
      name: row.name,
      schema: row.schemaName,
      keyPrefix: row.keyPrefix,
      tables: getTenantTables(row.schemaName),
    };
  });

  // Authed resolver — requires user is a member of the resolved company.
  app.decorate('requireCompany', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await app.getSession(request);
    if (!session?.user) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const slug = readSlug(request);
    if (!slug) {
      reply.code(400).send({ error: 'Missing or invalid X-Company-Slug header' });
      return;
    }
    const row = await loadCompany(slug);
    if (!row || !row.isActive) {
      reply.code(400).send({ error: 'Unknown company slug' });
      return;
    }
    const memberships = await db
      .select()
      .from(membership)
      .where(and(eq(membership.userId, session.user.id), eq(membership.companySlug, slug)))
      .limit(1);
    if (memberships.length === 0) {
      reply.code(403).send({ error: 'Not a member of this company' });
      return;
    }
    request.company = {
      slug: row.slug,
      name: row.name,
      schema: row.schemaName,
      keyPrefix: row.keyPrefix,
      tables: getTenantTables(row.schemaName),
    };
  });
};

export default fp(companyContext, { name: 'company-context', dependencies: ['auth-plugin'] });
