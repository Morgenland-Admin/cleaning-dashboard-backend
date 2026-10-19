import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, like, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { membership, tasks, user } from '../../db/schema/shared.js';

const SLUG = 'cleanilo';
const PREFIX = 'test-tasks-list';
const ME = { id: 'test-tasks-admin', accessLevel: 'admin', audience: 'admin' } as const;

async function databaseReachable(): Promise<boolean> {
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch {
    return false;
  }
}
const dbUp = await databaseReachable();

type TaskList = { items: Array<{ id: number; title: string }>; nextCursor: string | null };

describe(
  'tasks list routes (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const base = new Date('2020-03-01T10:00:00Z').getTime();

    before(async () => {
      await db
        .insert(user)
        .values({
          ...ME,
          name: ME.id,
          email: `${ME.id}@example.invalid`,
          emailVerified: true,
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: ME.id, companySlug: SLUG, role: 'admin', acceptedAt: new Date() })
        .onConflictDoNothing();
      // Rows 2–4 share one microsecond created_at (one statement): the cursor must not drop any.
      await db.insert(tasks).values(
        (['open', 'in_progress', 'open', 'done', 'dismissed'] as const).map((status, i) => ({
          companySlug: SLUG,
          kind: 'ad_hoc',
          title: `${PREFIX} ${i}`,
          status,
          assigneeUserId: ME.id,
          createdAt:
            i < 2 ? new Date(base + i * 60_000) : sql`'2020-03-01 11:00:00.123456+00'::timestamptz`,
        })),
      );

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        authUser: unknown;
        authSession: unknown;
      }) => {
        const session = { user: ME, session: { userId: ME.id } };
        request.authSession = session;
        request.authUser = ME;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      await db.delete(tasks).where(like(tasks.title, `${PREFIX}%`));
      await db
        .delete(membership)
        .where(and(eq(membership.userId, ME.id), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, ME.id));
      await pool.end();
    });

    const get = async <B>(url: string) => {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, res.body);
      return res.json<B>();
    };
    const ours = (list: TaskList) =>
      list.items.filter((t) => t.title.startsWith(PREFIX)).map((t) => t.title.slice(-1));

    it('lists open + in-progress tasks as "active"', async () => {
      const list = await get<TaskList>(
        `/admin/tasks?brand=${SLUG}&mine=true&status=active&limit=100`,
      );
      assert.deepEqual(ours(list), ['2', '1', '0']);
    });

    it('pages through tasks sharing a timestamp without gaps', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: TaskList = await get<TaskList>(
          `/admin/tasks?brand=${SLUG}&mine=true&status=all&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...ours(page));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, ['4', '3', '2', '1', '0']);
    });

    it('searches title and body', async () => {
      const list = await get<TaskList>(
        `/admin/tasks?brand=${SLUG}&mine=true&status=all&q=${encodeURIComponent(`${PREFIX} 3`)}`,
      );
      assert.deepEqual(ours(list), ['3']);
    });

    it('counts my tasks per status', async () => {
      const counts = await get<{ byStatus: Record<string, number> }>(
        `/admin/tasks/counts?brand=${SLUG}&mine=true`,
      );
      assert.equal(counts.byStatus.open, 2);
      assert.equal(counts.byStatus.in_progress, 1);
      assert.equal(counts.byStatus.done, 1);
      assert.equal(counts.byStatus.dismissed, 1);
    });
  },
);
