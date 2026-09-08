function asValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Compute the next future occurrence for the recurrence grammar already
 * supported by the scheduler. This is intentionally pure so recurrence timing
 * has one testable source of truth.
 */
export function computeNextRecurringSendAt(sendAt, recurrenceRule, now = new Date()) {
  const current = asValidDate(sendAt);
  const reference = asValidDate(now);
  const rule = String(recurrenceRule || '').trim().toLowerCase();
  if (!current || !reference || !rule) return null;

  const next = new Date(current.getTime());
  let guard = 0;
  while (next.getTime() <= reference.getTime() && guard < 10000) {
    guard += 1;
    if (rule === 'hourly') {
      next.setHours(next.getHours() + 1);
    } else if (rule.startsWith('hourly:')) {
      const hours = parseInt(rule.split(':')[1], 10) || 1;
      next.setHours(next.getHours() + hours);
    } else if (rule.startsWith('interval:') && rule.endsWith('m')) {
      const mins = parseInt(rule.slice(9, -1), 10) || 30;
      next.setMinutes(next.getMinutes() + mins);
    } else if (rule.startsWith('interval:') && rule.endsWith('h')) {
      const hours = parseInt(rule.slice(9, -1), 10) || 1;
      next.setHours(next.getHours() + hours);
    } else if (rule === 'daily') {
      next.setDate(next.getDate() + 1);
    } else if (rule === 'weekly' || rule.startsWith('weekly:')) {
      next.setDate(next.getDate() + 7);
    } else if (rule === 'monthly') {
      next.setMonth(next.getMonth() + 1);
    } else if (rule === 'weekdays') {
      next.setDate(next.getDate() + 1);
      if (next.getDay() === 6) next.setDate(next.getDate() + 2);
      else if (next.getDay() === 0) next.setDate(next.getDate() + 1);
    } else {
      // Preserve the scheduler's historical fallback for unknown recurrence
      // strings rather than silently stopping an existing routine.
      next.setDate(next.getDate() + 1);
    }
  }

  return guard >= 10000 ? null : next;
}
