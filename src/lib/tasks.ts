import { and, eq, sql } from 'drizzle-orm';

import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { company, membership, tasks, user } from '../db/schema/shared.js';
import { adminSender, sendEmail } from '../email/service.js';
import { taskAssignedEmail, taskCommentEmail } from '../email/templates.js';
import { sendPushToUser } from './push.js';

export type TaskKind =
  | 'contact_review'
  | 'inquiry_review'
  | 'order_dispute'
  | 'bad_review_followup'
  | 'partner_application'
  | 'ad_hoc';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'dismissed';

export interface SpawnTaskInput {
  companySlug: string;
  kind: TaskKind;
  refKind?: string;
  refId?: number;
  title: string;
  body?: string;
  priority?: TaskPriority;
  assigneeUserId?: string;
  metadata?: Record<string, unknown>;
}

/** Idempotent insert; returns existing task on (companySlug, refKind, refId) conflict. */
export async function spawnTask(input: SpawnTaskInput): Promise<{ id: number; created: boolean }> {
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

export async function getOpenTaskCountForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(membership, eq(membership.companySlug, tasks.companySlug))
    .where(and(eq(membership.userId, userId), eq(tasks.status, 'open')));
  return row?.count ?? 0;
}

type TaskRow = typeof tasks.$inferSelect;

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
  if (assigneeId === input.previousAssigneeUserId) return;
  if (assigneeId === input.triggeredByUserId) return;

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
    /* email failure swallowed — assignment already committed */
  }

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
  if (assigneeId === input.triggeredByUserId) return;

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
