import { describe, expect, it } from 'vitest';
import { behavioralReadMessage } from '../../fixtures/agent/behavioral-read-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';

describe('current behavioral integration read fixtures', () => {
  it.each([
    ['agendaTomorrow', 'get_unified_agenda', undefined, 'tomorrow'],
    ['calendarTomorrow', 'manage_google_calendar', 'list_events', 'tomorrow'],
    ['reminderList', 'manage_reminder', 'list', undefined],
    ['taskList', 'manage_task', 'list', undefined],
  ] as const)('%s validates strict provider wire and selects its domain tool', (key, toolName, action, scope) => {
    const message = behavioralReadMessage(key);
    expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
    const validation = validateForegroundContent(message.content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error(validation.error);
    expect(validation.intent.actions).toHaveLength(1);
    const call = buildDomainCall(validation.intent.actions[0], {
      user: { id: 'read-fixture-owner', phone_number: '573990001122', timezone: 'America/Bogota' },
      timezone: 'America/Bogota', language: 'es', referenceTime: '2026-09-02T17:00:00Z',
    });
    expect(call.valid).toBe(true);
    if (!call.valid || !('toolName' in call)) throw new Error('Read fixture did not select a domain tool');
    expect(call.toolName).toBe(toolName);
    if (action) expect(call.params.action).toBe(action);
    if (scope) expect(call.params.scope).toBe(scope);
    if (key === 'taskList') expect(call.params.status).toBe('all');
  });

  it('rejects the retired tool_call protocol rather than silently accepting an agenda mock', () => {
    expect(validateForegroundContent(JSON.stringify({
      type: 'tool_call', tool: 'get_unified_agenda', params: { scope: 'tomorrow' }, intent: 'unified_agenda',
    })).valid).toBe(false);
  });

  it('renders Calendar failure while retaining available reminders and tasks', () => {
    const card = formatCanonicalAgenda({
      scope: 'tomorrow', complete: false, calendar: { state: 'ERROR', events: [] },
      sources: { reminders: 'AVAILABLE', tasks: 'AVAILABLE' },
      reminders: [{ content: 'Revisar correo urgente', send_at: '2026-09-03T14:00:00Z' }],
      tasks: [{ title: 'Pagar factura de internet', status: 'pending' }],
    }, { language: 'es', timezone: 'America/Bogota' });
    expect(card).toContain('Google Calendar');
    expect(card).toContain('No disponible temporalmente');
    expect(card).toContain('Revisar correo urgente');
    expect(card).toContain('Pagar factura de internet');
    expect(card).not.toMatch(/No tienes eventos.*ni tareas/i);
  });
});
