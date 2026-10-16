import {
  adminMetricsResultSchema, type AdminRequest, type AdminMetricsResult,
} from '@templelabs/contracts';
import type { AdminDomainPort, ToolOutcome } from '@templelabs/tools';
import { supabase } from '../../infrastructure/database/index.js';
import { isAdminUser } from '../../shared/auth.js';
import type { ProductivityUser } from '../../features/productivity-domain.js';
import { checkDomainContext } from './domain-outcome.js';

interface MetricsQuery extends PromiseLike<{ count?: number | null; data?: Array<{ amount?: unknown }> | null; error?: unknown }> {
  select(columns: string, options?: { count?: string; head?: boolean }): MetricsQuery;
  eq(column: string, value: unknown): MetricsQuery;
  order(column: string, options: { ascending: boolean }): MetricsQuery;
}

interface MetricsClient {
  from(table: string): MetricsQuery;
}

export function createAdminDomainPort(user: ProductivityUser, getClient?: () => MetricsClient): AdminDomainPort {
  const userId = user.id;
  return {
    async execute(request: AdminRequest, context, operationId): Promise<ToolOutcome<AdminMetricsResult>> {
      const invalid = checkDomainContext(userId, context);
      if (invalid) return invalid;

      if (!isAdminUser(user)) {
        return {
          status: 'denied',
          code: 'AUTHORIZATION_ERROR',
          observation: 'Admin privileges required to consult administrative business metrics.',
        };
      }

      const client = getClient ? getClient() : (supabase as unknown as MetricsClient);

      try {
        const [
          { count: userCount },
          { data: activeSubs },
          { count: pendingRemindersCount },
          { count: pendingTasksCount },
        ] = await Promise.all([
          client.from('users').select('*', { count: 'exact', head: true }),
          client.from('subscriptions').select('amount, plan, status').eq('status', 'active'),
          client.from('reminders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
          client.from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        ]);

        const mrr = (activeSubs || []).reduce((acc: number, s: { amount?: unknown }) => acc + (Number(s.amount) || 0), 0);
        const card = context.language === 'en'
          ? `System Metrics:\n• Registered users: ${userCount || 0}\n• Active subscriptions: ${(activeSubs || []).length}\n• Total MRR: $${mrr}\n• Pending reminders: ${pendingRemindersCount || 0}\n• Pending tasks: ${pendingTasksCount || 0}`
          : `Métricas del Sistema:\n• Usuarios registrados: ${userCount || 0}\n• Suscripciones activas: ${(activeSubs || []).length}\n• MRR total: $${mrr}\n• Recordatorios pendientes: ${pendingRemindersCount || 0}\n• Tareas pendientes: ${pendingTasksCount || 0}`;

        const data: AdminMetricsResult = adminMetricsResultSchema.parse({
          operation: 'metrics',
          scope: request.input.scope ?? 'overview',
          totalUsers: userCount || 0,
          activeSubscriptions: (activeSubs || []).length,
          totalMRR: mrr,
          pendingReminders: pendingRemindersCount || 0,
          pendingTasks: pendingTasksCount || 0,
          complete: true,
          presentation: {
            canonicalCard: card,
            questions: [],
            cta: null,
          },
        });

        return {
          status: 'success',
          data,
          receipt: {
            userId,
            operationId,
            toolName: 'admin_metrics',
            resourceIds: [],
          },
          observation: JSON.stringify({
            operation: 'metrics',
            totalUsers: data.totalUsers,
            activeSubscriptions: data.activeSubscriptions,
            totalMRR: data.totalMRR,
          }),
        };
      } catch (err: unknown) {
        return {
          status: 'failed',
          code: 'METRICS_ERROR',
          observation: err instanceof Error ? err.message : 'Failed to query admin metrics.',
        };
      }
    },
  };
}
