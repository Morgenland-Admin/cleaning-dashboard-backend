/**
 * Recomputes every partner-chat conversation's preview and last-message time from its newest
 * message (cleans up "[Anhang im alten System: …]" previews left by the legacy import).
 * Direct tenant writes, no events; idempotent. Dry run by default.
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/refresh-chat-previews.ts [--commit]
 */
import { desc, eq } from 'drizzle-orm';

import { db, pool } from '../src/db/index.ts';
import { company } from '../src/db/schema/shared.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { previewOf } from '../src/modules/chat/lib.ts';

const COMMIT = process.argv.includes('--commit');

async function main() {
  const companies = await db.select().from(company);
  for (const c of companies) {
    const T = getTenantTables(c.schemaName);
    const conversations = await db.select().from(T.chatConversations);
    let changed = 0;
    for (const conv of conversations) {
      const [last] = await db
        .select()
        .from(T.chatMessages)
        .where(eq(T.chatMessages.conversationId, conv.id))
        .orderBy(desc(T.chatMessages.createdAt), desc(T.chatMessages.id))
        .limit(1);
      if (!last) continue;
      const preview = previewOf(last.body, last.attachments);
      const same =
        conv.lastMessagePreview === preview &&
        conv.lastMessageAt?.getTime() === last.createdAt.getTime();
      if (same) continue;
      changed += 1;
      if (COMMIT) {
        await db
          .update(T.chatConversations)
          .set({ lastMessagePreview: preview, lastMessageAt: last.createdAt })
          .where(eq(T.chatConversations.id, conv.id));
      }
    }
    console.log(
      `${c.slug}: ${conversations.length} conversations, ${changed} ${COMMIT ? 'updated' : 'to update'}`,
    );
  }
  if (!COMMIT) console.log('Dry run only. Add --commit to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
