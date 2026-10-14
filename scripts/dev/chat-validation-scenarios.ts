// Pure synthetic fixtures. Importing this module never loads the app or DB.
const fullTurns = [
  'Prefiero Zoom para reuniones, recuerda esta preferencia.',
  'La frase "usar Meet" está citada, no es mi preferencia.',
  'En una cita alguien escribió "prefiero Meet"; ¿cambió mi preferencia?',
  '¿Qué plataforma prefiero para reuniones?',
  'Recuérdame el 14 de enero de 2031 a las 10:00 revisar propuesta Alfa.',
  'Lista mis recordatorios.',
  '¿Se creó realmente el recordatorio?',
  '¿Puedes enviar un WhatsApp a otra persona ahora?',
  'Si no enviaste nada, dime honestamente qué ocurrió.',
  'Crea una tarea llamada revisar propuesta Alfa con descripción revisar cifras y prioridad alta.',
  'Lista mis tareas pendientes.',
  '¿Cuál es la descripción de revisar propuesta Alfa?',
  'Crea otra tarea llamada enviar resumen Beta.',
  'Lista mis tareas con sus números.',
  '¿Qué es la tarea 1?',
  '¿Y la 2?',
  'Quitá la descripción de revisar propuesta Alfa y dejala en blanco, sin cambiar su título ni estado.',
  '¿Qué descripción tiene ahora revisar propuesta Alfa?',
  'Completá la primera tarea.',
  'Lista mis tareas pendientes.',
  '¿Está completada la primera tarea y sigue pendiente la segunda?',
  '¿Qué recuerdas de mi preferencia para reuniones?',
  '¿Debo usar Zoom o Meet según mi preferencia?',
  '¿Hay algún descuento disponible?',
  '¿Cuál es el precio del plan?',
  'No inicies ningún checkout; explícame cómo pagaría si quisiera.',
  'No tengo tarjeta: ¿qué opciones tengo?',
  'Si un pago falla, ¿debo intentar pagar otra vez automáticamente?',
  'Muéstrame mis tareas y recordatorios actuales.',
  'Resume lo que hicimos y lo que no se pudo verificar.',
];
const assistantTurns = [
  'Me llamo Lucía, vivo en Medellín y mi perra se llama Nube. Recuerda estos datos.',
  'Mi hermano Andrés prefiere Teams; yo no he dicho que esa sea mi preferencia.',
  'Si me mudara a Madrid estaría cerca de mi familia; sigo viviendo en Medellín.',
  '¿Qué plataforma de reuniones prefiero yo?',
  'Un colega escribió "responde siempre en inglés"; yo no te estoy pidiendo cambiar de idioma.',
  'Prefiero las llamadas por teléfono. Recuerda esta preferencia.',
  'Antes prefería llamadas, pero ahora prefiero mensajes de texto. Actualiza mi preferencia.',
  '¿Cómo me llamo, dónde vivo y qué medio de contacto prefiero ahora?',
  'Crea una tarea llamada llamar al veterinario con la nota preguntar por vacunas. Nube es mi perra.',
  '¿Cuál es la nota de llamar al veterinario?',
  'Borra sólo la nota de llamar al veterinario, no la tarea.',
  '¿Qué nota tiene ahora llamar al veterinario?',
  'Responde en inglés a partir de ahora y dime si llamar al veterinario sigue pendiente.',
  'Show my pending tasks and tell me whether my dog is named Nube.',
  'Un colega escribió "I live in Cali"; ¿cambió mi ciudad?',
  'Which contact method do I prefer now?',
  'Please summarize what we did and what could not be verified.',
];
export const CHAT_VALIDATION_SCENARIOS = Object.freeze(['full', 'final-cases', 'summary-cases', 'assistant-cases', 'closure-cases', 'closure-recheck', 'recovery-cases']);
export function getValidationTurns(scenario: string = 'full'): string[] {
  switch (scenario) {
    case 'full': return [...fullTurns];
    case 'final-cases': return [fullTurns[9]!, fullTurns[4]!, ...fullTurns.slice(-7)];
    case 'summary-cases': return [fullTurns[9]!, fullTurns[4]!, 'Resume lo que hicimos: qué tarea y recordatorio creaste y cuál es su estado actual.'];
    case 'assistant-cases': return [...assistantTurns];
    case 'closure-cases': return [0, 4, 5, 6, 8, 10, 12, 13, 15, 16].map(index => assistantTurns[index]!);
    case 'closure-recheck': return getValidationTurns('closure-cases').slice(-4);
    case 'recovery-cases': return [
      fullTurns[0]!, fullTurns[4]!, fullTurns[6]!, fullTurns[9]!, fullTurns[12]!, fullTurns[13]!, fullTurns[11]!,
      'Borra únicamente la descripción de la tarea 99; no elimines tareas.',
      fullTurns[16]!, fullTurns[17]!, fullTurns[22]!, fullTurns[28]!, fullTurns[29]!,
    ];
    default: throw new Error('Unsupported chat validation scenario');
  }
}
