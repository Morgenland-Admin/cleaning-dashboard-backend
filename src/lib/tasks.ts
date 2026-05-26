/**
 * Tasks helpers (ALL_103).
 *
 * Public surface:
 *   - spawnTask(...) — idempotent insert (ON CONFLICT on the source-event
 *     unique index). Used by contact / inquiry / order modules.
 *   - getOpenTaskCountForUser(...) — sidebar badge.
 *   - notifyTaskAssigned(...) — email + push when a task lands on someone.
 *   - notifyTaskComment(...) — email + push when a new comment arrives.
 *
 * Routes for read / update live in modules/tasks/routes.ts.
 */

import { and, eq, sql } from 'drizzle-orm';

import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { company, membership, tasks, user } from '../db/schema/shared.js';
import { adminSender, sendEmail } from '../email/service.js';
import { taskAssignedEmail, taskCommentEmail } from '../email/templates.js';
import { sendPushToUser } from './push.js';

export type TaskKind =
  | 'contact_review' // someone filled the contact form
  | 'inquiry_review' // someone filled the inquiry form
  | 'order_dispute' // future — customer reported a problem
  | 'bad_review_followup' // future — 1-2 star review needs response
  | 'partner_application' // future — new partner registration
  | 'ad_hoc'; // manually created by admins

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'dismissed';

export interface SpawnTaskInput {
  companySlug: string;
  kind: TaskKind;
  /** Source table + row id — used for dedup so the same event can't spawn twice. */
  refKind?: string;
  refId?: number;
  title: string;
  body?: string;
  priority?: TaskPriority;
  assigneeUserId?: string;
  metadata?: Record<string, unknown>;
}

/** Idempotent insert. Returns the existing task on conflict so the caller can
 *  surface "already created" without a separate read. */
export async function spawnTask(input: SpawnTaskInput): Promise<{ id: number; created: boolean }> {
  // No ref pair → no dedup possible, just insert.
  if (!input.refKind || input.refId == null) {
    const [row] = await db
      .insert(tasks)
      .values({
        companySlug: input.companySlug,
        kind: input.kind,
        title: input.title,
        body: input.body,
        priority: input.priority ?? 'normal',
        assigneeUserId: input.assigneeUserId,
        metadata: input.metadata ?? {},
      })
      .returning({ id: tasks.id });
    return { id: row!.id, created: true };
  }

  // With ref pair → ON CONFLICT DO NOTHING + RETURNING — Postgres returns
  // empty when the conflict suppresses the insert, so a follow-up SELECT is
  // needed to fetch the pre-existing row.
  const [inserted] = await db
    .insert(tasks)
    .values({
      companySlug: input.companySlug,
      kind: input.kind,
      refKind: input.refKind,
      refId: input.refId,
      title: input.title,
      body: input.body,
      priority: input.priority ?? 'normal',
      assigneeUserId: input.assigneeUserId,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [tasks.companySlug, tasks.refKind, tasks.refId],
    })
    .returning({ id: tasks.id });

  if (inserted) return { id: inserted.id, created: true };

  const [existing] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companySlug, input.companySlug),
        eq(tasks.refKind, input.refKind),
        eq(tasks.refId, input.refId),
      ),
    )
    .limit(1);
  return { id: existing!.id, created: false };
}

/** Count of open tasks across all brands the user has membership in. Used by
 *  the sidebar/header badge. */
export async function getOpenTaskCountForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(membership, eq(membership.companySlug, tasks.companySlug))
    .where(and(eq(membership.userId, userId), eq(tasks.status, 'open')));
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
//  Notifications
//
//  Both helpers fire email + push in parallel. Push failures are silent
//  (no VAPID configured → no-op); email failures are swallowed after logging
//  because the parent action (assignment / comment) is already committed.
// ---------------------------------------------------------------------------

type TaskRow = typeof tasks.$inferSelect;

/** URL the assignee should land on when they click the email/push. */
function buildTaskUrl(taskId: number): string {
  return `${env.APP_BASE_URL.replace(/\/$/, '')}/tasks?id=${taskId}`;
}

interface NotifyAssignedInput {
  task: TaskRow;
  previousAssigneeUserId: string | null;
  triggeredByUserId: string;
}

export async function notifyTaskAssigned(input: NotifyAssignedInput): Promise<void> {
  const assigneeId = input.task.assigneeUserId;
  if (!assigneeId) return;
  if (assigneeId === input.previousAssigneeUserId) return; // no real change
  if (assigneeId === input.triggeredByUserId) return; // self-assign — quiet

  const [assignee] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, assigneeId))
    .limit(1);
  if (!assignee) return;

  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, input.task.companySlug))
    .limit(1);
  const brandName = companyRow?.name ?? input.task.companySlug;
  const url = buildTaskUrl(input.task.id);

  // Email first — durable.
  try {
    await sendEmail({
      to: assignee.email,
      from: adminSender(),
      email: taskAssignedEmail({
        recipientName: assignee.name,
        brandName,
        taskTitle: input.task.title,
        taskBody: input.task.body ?? null,
        priority: input.task.priority,
        dueAt: input.task.dueAt?.toISOString() ?? null,
        taskUrl: url,
      }),
    });
  } catch {
    /* email send failed — swallowed; the assignment already succeeded */
  }

  // Push best-effort.
  try {
    await sendPushToUser(assigneeId, {
      title: `${brandName} · Aufgabe zugewiesen`,
      body: input.task.title,
      url: `/tasks?id=${input.task.id}`,
      tag: `task:${input.task.id}`,
      brandSlug: input.task.companySlug,
    });
  } catch {
    /* push best-effort */
  }
}

interface NotifyCommentInput {
  task: TaskRow;
  commentBody: string;
  triggeredByUserId: string;
}

export async function notifyTaskComment(input: NotifyCommentInput): Promise<void> {
  const assigneeId = input.task.assigneeUserId;
  if (!assigneeId) return;
  if (assigneeId === input.triggeredByUserId) return; // talking to themselves

  const [assignee] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, assigneeId))
    .limit(1);
  if (!assignee) return;

  const [author] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, input.triggeredByUserId))
    .limit(1);

  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, input.task.companySlug))
    .limit(1);
  const brandName = companyRow?.name ?? input.task.companySlug;
  const url = buildTaskUrl(input.task.id);
  const authorName = author?.name ?? 'Ein Kollege';

  try {
    await sendEmail({
      to: assignee.email,
      from: adminSender(),
      email: taskCommentEmail({
        recipientName: assignee.name,
        authorName,
        brandName,
        taskTitle: input.task.title,
        commentBody: input.commentBody,
        taskUrl: url,
      }),
    });
  } catch {
    /* swallowed */
  }

  try {
    await sendPushToUser(assigneeId, {
      title: `${authorName}: ${input.task.title}`,
      body: input.commentBody.slice(0, 120),
      url: `/tasks?id=${input.task.id}`,
      tag: `task:${input.task.id}`,
      brandSlug: input.task.companySlug,
    });
  } catch {
    /* push best-effort */
  }
}
