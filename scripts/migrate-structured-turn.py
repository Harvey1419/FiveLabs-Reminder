from pathlib import Path
import re

p=Path('src/agent/providers/client.js'); s=p.read_text(); s=s.replace("  startStage = null,\n} = {}) {", "  startStage = null,\n  responseFormat: requestedResponseFormat = null,\n} = {}) {")
old="""    responseFormat: nativeToolMode ? null : { type: 'json_object' },
    tools,
    toolChoice,"""; new="""    responseFormat: requestedResponseFormat || (nativeToolMode ? null : { type: 'json_object' }),
    tools: requestedResponseFormat ? null : tools,
    toolChoice: requestedResponseFormat ? 'none' : toolChoice,"""
if old not in s: raise SystemExit('client response-format anchor missing')
s=s.replace(old,new); p.write_text(s)

p=Path('src/agent/orchestration/router-core.js'); s=p.read_text(); s=s.replace("import { getForegroundToolDefinitions, getIntentToolDefinitions, parseIntentArguments, validateTurnIntent } from '../contracts/intent-contracts.js';", "import { TURN_INTENT_SCHEMA, parseIntentArguments, validateTurnIntent } from '../contracts/intent-contracts.js';")
marker='function getAttachmentOnlyIntentTools({ isAdmin = false } = {}) {'; end=s.index('\n}\n\nfunction enforceAttachmentOnlyIntent', s.index(marker))+3
helper=r'''function nullableSchema(schema) {
  const node = structuredClone(schema);
  if (node.items) node.items = nullableSchema(node.items);
  if (node.properties) {
    const originallyRequired = new Set(node.required || []);
    for (const [key, child] of Object.entries(node.properties)) {
      const converted = nullableSchema(child);
      if (!originallyRequired.has(key)) {
        const types = Array.isArray(converted.type) ? converted.type : [converted.type];
        if (converted.type && !types.includes('null')) converted.type = [...types, 'null'];
        if (Array.isArray(converted.enum) && !converted.enum.includes(null)) converted.enum = [...converted.enum, null];
      }
      node.properties[key] = converted;
    }
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  return node;
}
function stripStructuredNulls(value) {
  if (Array.isArray(value)) return value.map(stripStructuredNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null).map(([key, child]) => [key, stripStructuredNulls(child)]));
}
function getStructuredTurnSchema({ isAdmin = false, attachmentOnly = false } = {}) {
  const schema = structuredClone(TURN_INTENT_SCHEMA);
  const domains = schema.properties.actions.items.properties.domain.enum;
  schema.properties.actions.items.properties.domain.enum = attachmentOnly ? ['conversation'] : domains.filter((domain) => isAdmin || domain !== 'admin');
  return nullableSchema(schema);
}
function parseStructuredTurnDecision(modelResponse, { isAdmin = false } = {}) {
  if (modelResponse?.unavailable) return { unavailable: true, validation: null };
  const parsed = parseIntentArguments(modelResponse?.content);
  if (!parsed) return { unavailable: false, validation: { valid: false, errorCode: 'INVALID_PARAMETERS', error: 'La decisión estructurada no era JSON válido.' } };
  return { unavailable: false, validation: validateTurnIntent(stripStructuredNulls(parsed), { isAdmin }) };
}
'''
s=s[:s.index(marker)]+helper+s[end:]
old="""  const intentTools = isAttachmentOnlyTurn
    ? getAttachmentOnlyIntentTools({ isAdmin })
    : getForegroundToolDefinitions({ isAdmin });"""; new="""  const turnResponseFormat = { type: 'json_schema', json_schema: { name: 'hermes_turn_intent', strict: true, schema: getStructuredTurnSchema({ isAdmin, attachmentOnly: isAttachmentOnlyTurn }) } };"""
if old not in s: raise SystemExit('router tool declaration anchor missing')
s=s.replace(old,new).replace("      tools: intentTools,\n      toolChoice: 'required',", "      tools: null,\n      toolChoice: 'none',\n      responseFormat: turnResponseFormat,").replace('model decision in ${modelElapsedMs}ms toolCalls=${decision.toolCalls.length} proseChars=${decision.content.length}', 'model decision in ${modelElapsedMs}ms structuredChars=${decision.content.length}').replace('let collected = collectIntent(decision.toolCalls, { isAdmin });', "const structuredDecision = parseStructuredTurnDecision(decision, { isAdmin });\n  let collected = structuredDecision.unavailable ? { valid: true, intent: null } : structuredDecision.validation;")
p.write_text(s)

for p in Path('tests/unit/agent').glob('*.test.js'):
    s=p.read_text(); s=re.sub(r"function modelToolCall\(payload\) \{.*?\n\}", "function modelToolCall(payload) {\n  return { role: 'assistant', content: JSON.stringify(payload), tool_calls: [] };\n}", s, flags=re.S)
    s=s.replace("toolChoice: 'required', purpose: 'initial'", "toolChoice: 'none', purpose: 'initial', responseFormat: expect.objectContaining({ type: 'json_schema' })").replace("{ toolChoice: 'required', purpose: 'initial' }", "{ toolChoice: 'none', purpose: 'initial', responseFormat: expect.objectContaining({ type: 'json_schema' }) }").replace("expect.objectContaining({ toolChoice: 'required' })", "expect.objectContaining({ toolChoice: 'none', responseFormat: expect.objectContaining({ type: 'json_schema' }) })")
    p.write_text(s)

p=Path('tests/unit/agent/router-native-orchestration.test.js'); s=p.read_text(); s=s.replace("expect(result.plan.type).toBe('missing_structured_decision');", "expect(result.plan.type).toBe('invalid_intent');"); p.write_text(s)
p=Path('tests/unit/agent/attachment-routing.test.js'); s=p.read_text(); s=s.replace("    expect(options.toolChoice).toBe('required');\n    expect(options.tools).toHaveLength(1);\n    expect(options.tools[0].function.name).toBe('execute_turn');\n    expect(options.tools[0].function.parameters.properties.actions.items.properties.domain.enum)\n      .toEqual(['conversation']);", "    expect(options.toolChoice).toBe('none');\n    expect(options.tools).toBeNull();\n    expect(options.responseFormat.type).toBe('json_schema');\n    expect(options.responseFormat.json_schema.strict).toBe(true);\n    expect(options.responseFormat.json_schema.schema.properties.actions.items.properties.domain.enum).toEqual(['conversation']);"); p.write_text(s)
p=Path('tests/unit/agent/runtime-model-contract.test.js'); s=p.read_text(); s=s.replace("it('requires execute_turn on the initial Hermes decision and has no semantic recovery round'", "it('requires strict TurnIntent JSON on the initial Hermes decision and has no semantic recovery round'").replace("    expect(source).toContain(\"toolChoice: 'required'\");", "    expect(source).toContain(\"type: 'json_schema'\");\n    expect(source).toContain('strict: true');\n    expect(source).toContain(\"toolChoice: 'none'\");"); p.write_text(s)

p=Path('tests/unit/agent/provider-latency-regressions.test.js'); s=p.read_text(); s=s.replace("function toolResponse(provider = 'Baseten') {", "function structuredResponse(provider = 'Groq') {\n  return new Response(JSON.stringify({ provider, choices: [{ finish_reason: 'stop', message: { content: '{\\\"actions\\\":[{\\\"domain\\\":\\\"conversation\\\",\\\"action\\\":\\\"reply\\\",\\\"content\\\":\\\"¡Hola!\\\"}]}' } }], usage: { prompt_tokens: 1200, completion_tokens: 30 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });\n}\n\nfunction toolResponse(provider = 'Baseten') {")
s=re.sub(r"  it\('does not retry the same foreground provider.*?\n  \}\);", "  it('sends strict structured output to Groq without tools', async () => {\n    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(structuredResponse('Groq'));\n    const responseFormat = { type: 'json_schema', json_schema: { name: 'turn', strict: true, schema: { type: 'object', additionalProperties: false, properties: { actions: { type: 'array', items: { type: 'object' } } }, required: ['actions'] } } };\n    const result = await callChatCompletion([{ role: 'user', content: 'Hola hola' }], { tools: null, toolChoice: 'none', responseFormat, returnMessage: true, purpose: 'initial' });\n    expect(result.content).toContain('actions');\n    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);\n    expect(payload.provider.only).toEqual(['groq']);\n    expect(payload.response_format).toEqual(responseFormat);\n    expect(payload).not.toHaveProperty('tools');\n    expect(payload).not.toHaveProperty('tool_choice');\n  });", s, count=1, flags=re.S); p.write_text(s)
