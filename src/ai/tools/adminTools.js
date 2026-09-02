import { supabase } from '../../db/index.js';
import { isAdminUser } from '../../utils/auth.js';

/**
 * Domain tool for administrative system metrics with strict RBAC.
 */
export async function executeAdminTool({ action, params = {}, user, language = 'es' }) {
  if (!isAdminUser(user)) {
    return {
      success: false,
      action: 'unauthorized',
      errorCode: 'AUTHORIZATION_ERROR',
      error: 'Acceso no autorizado: esta herramienta requiere privilegios de administrador.',
      rawSummary: 'Acceso no autorizado: esta herramienta requiere privilegios de administrador.',
    };
  }

  switch (action) {
    case 'get_overview': {
      const [
        { count: userCount },
        { data: activeSubs },
        { count: pendingRemindersCount },
        { count: pendingTasksCount },
      ] = await Promise.all([
        supabase.from('users').select('*', { count: 'exact', head: true }),
        supabase.from('subscriptions').select('amount, plan, status').eq('status', 'active'),
        supabase.from('reminders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      ]);

      const mrr = (activeSubs || []).reduce((acc, s) => acc + (Number(s.amount) || 0), 0);
      const overviewData = {
        totalUsers: userCount || 0,
        activeSubscriptions: (activeSubs || []).length,
        totalMRR: mrr,
        pendingReminders: pendingRemindersCount || 0,
        pendingTasks: pendingTasksCount || 0,
      };

      const rawSummary = `Métricas del Sistema:\n• Usuarios registrados: ${overviewData.totalUsers}\n• Suscripciones activas: ${overviewData.activeSubscriptions}\n• MRR total: $${overviewData.totalMRR}\n• Recordatorios pendientes: ${overviewData.pendingReminders}\n• Tareas pendientes: ${overviewData.pendingTasks}`;

      return {
        success: true,
        action: 'admin_overview',
        data: overviewData,
        rawSummary,
        formattedCard: rawSummary,
      };
    }

    case 'get_active_subscriptions': {
      const { data: subs } = await supabase
        .from('subscriptions')
        .select('id, user_id, plan, status, amount, created_at, users:user_id(phone_number, display_name)')
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      const rawSummary = `Hay ${subs?.length || 0} suscripciones activas registradas.`;

      return {
        success: true,
        action: 'admin_active_subscriptions',
        data: subs || [],
        rawSummary,
        formattedCard: rawSummary,
      };
    }

    case 'get_user_count': {
      const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true });

      const rawSummary = `Total de usuarios en la plataforma: ${count || 0}.`;

      return {
        success: true,
        action: 'admin_user_count',
        data: { totalUsers: count || 0 },
        rawSummary,
        formattedCard: rawSummary,
      };
    }

    default:
      return {
        success: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para admin_metrics.`,
      };
  }
}
