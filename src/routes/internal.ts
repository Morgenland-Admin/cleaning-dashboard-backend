import type { FastifyPluginAsync } from 'fastify';
import { inquiriesIntakeRoutes } from '../modules/inquiries/intake.js';

/** Machine-to-machine (voice-AI / n8n): shared service token, no user session. */
const internalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(inquiriesIntakeRoutes, { prefix: '/inquiries' });
};

export default internalRoutes;
