/**
 * Presentation Design System Tokens
 * Centralized visual tokens for all WhatsApp and messaging renderers.
 * Decouples UI representation from domain logic and avoids hardcoded strings/emojis.
 */
export const PRESENTATION_TOKENS = Object.freeze({
  ICONS: {
    // Schedule/calendar date & time icon (replaces clock icon)
    SCHEDULE_TIME: '🗓️',
    ALARM: '⏰',
    NOTIFICATION: '🔔',
    COMPLETED: '✅',
    CANCELLED: '🗑️',
    PROJECT_FOLDER: '📁',
    ADVANCE_NOTICE: '🔔 [Aviso Previo]',
    RECURRING_BADGE: '· recurrente',
  },
  FORMAT: {
    INDENT: '   ',
    BULLET: '• ',
  },
});
