/** Direct authored requests only. Durability, attribution and scope stay semantic. */
export function explicitMemoryIntent(text: string, operation: 'save' | 'forget'): boolean {
  const authored = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»/gu, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return authored.split(/[.!?;,]\s+|\n+/u).some(clause => {
    const direct = clause.trim().replace(/^[^\p{L}\p{N}]*/u, '')
      .replace(/^(?:por favor,?\s+|please,?\s+|(?:puedes|podrias|can you|could you|quiero que|me gustaria que|i want you to)\s+)/u, '');
    return operation === 'save'
      ? /^(?:recuerda\b|recuerdes\b|recorda\b|remember\b|guarda\b|guardes\b|guardar\b|save\b|aprende\b|toma nota\b)/u.test(direct)
      : /^(?:olvida\b|olvides\b|olvidar\b|forget\b)/u.test(direct) || (/^(?:borra\b|elimina\b|delete\b|remove\b)/u.test(direct) && /\b(?:memoria|recuerdos?|memor(?:y|ies))\b/u.test(direct));
  });
}
