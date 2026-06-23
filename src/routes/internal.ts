import type { FastifyPluginAsync } from 'fastify';
import { inquiriesIntakeRoutes } from '../modules/inquiries/intake.js';

/**
 * Machine-to-machine endpoints, authenticated by a shared service token rather
 * than a user session. Used by the voice-AI / n8n funnel. Not browser-facing.
 */
const internalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(inquiriesIntakeRoutes, { prefix: '/inquiries' });
};

export default internalRoutes;
