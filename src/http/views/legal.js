/**
 * Render Privacy Policy Page adhering to Google API Services User Data Policy.
 * @returns {string} HTML document
 */
export function renderPrivacyPolicyPage() {
  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Política de Privacidad — Hermes TempleLabs</title>
        <meta name="application-name" content="Hermes TempleLabs" />
        <meta property="og:site_name" content="Hermes TempleLabs" />
        <meta property="og:title" content="Política de Privacidad — Hermes TempleLabs" />
        <link rel="icon" type="image/png" href="/Logo.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            background: #09090b;
            color: #d4d4d8;
            line-height: 1.7;
            padding: 2.5rem 1.5rem;
          }
          .wrapper {
            max-width: 800px;
            margin: 0 auto;
            background: rgba(18, 18, 22, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 1.5rem;
            padding: 3rem 2.5rem;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
          }
          .brand-header {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 2rem;
            padding-bottom: 1.5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          }
          .brand-header img {
            width: 48px;
            height: 48px;
            border-radius: 0.85rem;
            border: 1px solid rgba(255, 255, 255, 0.18);
            object-fit: cover;
            background: #000000;
          }
          .brand-header h2 {
            font-size: 1.25rem;
            font-weight: 800;
            color: #ffffff;
          }
          h1 {
            font-size: 2.1rem;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: -0.03em;
            margin-bottom: 0.5rem;
          }
          .last-updated {
            font-size: 0.85rem;
            color: #71717a;
            margin-bottom: 2rem;
          }
          h2 {
            font-size: 1.3rem;
            font-weight: 700;
            color: #f4f4f5;
            margin: 2rem 0 0.75rem 0;
          }
          p, ul {
            margin-bottom: 1.2rem;
            font-size: 0.96rem;
          }
          ul {
            padding-left: 1.5rem;
          }
          li {
            margin-bottom: 0.4rem;
          }
          .highlight-box {
            background: rgba(34, 197, 94, 0.08);
            border: 1px solid rgba(34, 197, 94, 0.25);
            border-radius: 1rem;
            padding: 1.5rem;
            margin: 1.5rem 0;
          }
          .highlight-box h3 {
            color: #4ade80;
            font-size: 1.05rem;
            margin-bottom: 0.5rem;
          }
          a {
            color: #60a5fa;
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
          .footer {
            margin-top: 3rem;
            padding-top: 1.5rem;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 0.85rem;
            color: #71717a;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="brand-header">
            <img src="/Logo.png" alt="Hermes TempleLabs" />
            <div>
              <h2>Hermes TempleLabs</h2>
              <span style="font-size: 0.8rem; color: #71717a;">Intelligent Personal Assistant</span>
            </div>
          </div>

          <h1>Política de Privacidad</h1>
          <div class="last-updated">Última actualización: 1 de septiembre de 2026</div>

          <p>En <strong>Hermes TempleLabs</strong> respetamos tu privacidad y nos comprometemos a proteger los datos personales que compartes con nosotros para la operación de nuestro asistente inteligente de productividad y recordatorios a través de WhatsApp y herramientas asociadas.</p>

          <h2>1. Información que recopilamos</h2>
          <p>Para brindarte el servicio de asistente de recordatorios, recopilamos la siguiente información mínima necesaria:</p>
          <ul>
            <li><strong>Identificadores de contacto:</strong> Tu número de teléfono de WhatsApp y nombre de perfil para comunicarnos contigo y enviarte alertas.</li>
            <li><strong>Contenido conversacional:</strong> Textos, audios o notas que tú voluntariamente envías al bot para programar recordatorios, tareas y memorias de proyectos.</li>
            <li><strong>Datos de integración con Google Calendar (OAuth 2.0):</strong> Si decides voluntariamente vincular tu cuenta de Google, recibimos tokens de autorización cifrados para consultar y crear eventos exclusivamente en tu nombre.</li>
          </ul>

          <div class="highlight-box">
            <h3>🔒 Cláusula de Uso Limitado de las APIs de Google</h3>
            <p style="margin-bottom: 0;">El uso y la transferencia que <strong>Hermes TempleLabs</strong> haga de la información recibida a través de las APIs de Google hacia cualquier otra aplicación se adhiere a la <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Política de Datos de Usuario de los Servicios de las APIs de Google</a>, incluidos los requisitos de <strong>Uso Limitado (Limited Use Requirements)</strong>. No utilizamos tus datos de Google para publicidad de terceros ni entrenamos modelos públicos con tu información privada.</p>
          </div>

          <h2>2. Cómo utilizamos tu información</h2>
          <p>Tus datos son utilizados única y exclusivamente para:</p>
          <ul>
            <li>Programar, notificar y enviar tus recordatorios y tareas puntuales o recurrentes en WhatsApp.</li>
            <li>Consultar eventos existentes en tu Google Calendar para avisarte de cruces de horarios y redactar tu <em>Morning Briefing</em> diario.</li>
            <li>Crear nuevos eventos en tu calendario de Google cuando se lo solicites explícitamente al asistente.</li>
            <li>Mejorar tu contexto personal y recordar preferencias de trabajo que nos indiques guardar.</li>
          </ul>

          <h2>3. Seguridad y Almacenamiento</h2>
          <p>Implementamos estándares estrictos de seguridad de la información:</p>
          <ul>
            <li>Toda la comunicación web y webhooks viajan a través de canales cifrados HTTPS/TLS.</li>
            <li>Los tokens de acceso y actualización de Google OAuth se guardan en bases de datos con aislamiento multi-tenant y políticas de seguridad a nivel de fila (Row Level Security).</li>
          </ul>

          <h2>4. Control de tus Datos y Derecho al Olvido</h2>
          <p>Tú mantienes el control total de tu información en todo momento:</p>
          <ul>
            <li><strong>Desvincular Google Calendar:</strong> Puedes revocar el acceso en cualquier momento simplemente escribiendo <em>"desconectar google"</em> en WhatsApp o desde la configuración de seguridad de tu cuenta de Google.</li>
            <li><strong>Eliminar Memorias y Datos:</strong> Puedes solicitar la eliminación de todos tus datos o memorias registradas escribiendo <em>"olvida todo sobre mí"</em> o contactando a nuestro equipo.</li>
          </ul>

          <h2>5. Contacto</h2>
          <p>Si tienes preguntas sobre esta Política de Privacidad o el tratamiento de tus datos, puedes contactarnos a través de WhatsApp o escribiendo a <strong>soporte@templelabs.co</strong>.</p>

          <div class="footer">
            <div>© 2026 TempleLabs. Todos los derechos reservados.</div>
            <div>
              <a href="/terms">Condiciones del Servicio</a>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

/**
 * Render Terms of Service Page.
 * @returns {string} HTML document
 */
export function renderTermsOfServicePage() {
  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Condiciones del Servicio — Hermes TempleLabs</title>
        <meta name="application-name" content="Hermes TempleLabs" />
        <meta property="og:site_name" content="Hermes TempleLabs" />
        <meta property="og:title" content="Condiciones del Servicio — Hermes TempleLabs" />
        <link rel="icon" type="image/png" href="/Logo.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            background: #09090b;
            color: #d4d4d8;
            line-height: 1.7;
            padding: 2.5rem 1.5rem;
          }
          .wrapper {
            max-width: 800px;
            margin: 0 auto;
            background: rgba(18, 18, 22, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 1.5rem;
            padding: 3rem 2.5rem;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
          }
          .brand-header {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 2rem;
            padding-bottom: 1.5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          }
          .brand-header img {
            width: 48px;
            height: 48px;
            border-radius: 0.85rem;
            border: 1px solid rgba(255, 255, 255, 0.18);
            object-fit: cover;
            background: #000000;
          }
          .brand-header h2 {
            font-size: 1.25rem;
            font-weight: 800;
            color: #ffffff;
          }
          h1 {
            font-size: 2.1rem;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: -0.03em;
            margin-bottom: 0.5rem;
          }
          .last-updated {
            font-size: 0.85rem;
            color: #71717a;
            margin-bottom: 2rem;
          }
          h2 {
            font-size: 1.3rem;
            font-weight: 700;
            color: #f4f4f5;
            margin: 2rem 0 0.75rem 0;
          }
          p, ul {
            margin-bottom: 1.2rem;
            font-size: 0.96rem;
          }
          ul {
            padding-left: 1.5rem;
          }
          li {
            margin-bottom: 0.4rem;
          }
          a {
            color: #60a5fa;
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
          .footer {
            margin-top: 3rem;
            padding-top: 1.5rem;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 0.85rem;
            color: #71717a;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="brand-header">
            <img src="/Logo.png" alt="Hermes TempleLabs" />
            <div>
              <h2>Hermes TempleLabs</h2>
              <span style="font-size: 0.8rem; color: #71717a;">Intelligent Personal Assistant</span>
            </div>
          </div>

          <h1>Condiciones del Servicio</h1>
          <div class="last-updated">Última actualización: 1 de septiembre de 2026</div>

          <p>Bienvenido a <strong>Hermes TempleLabs</strong>. Al interactuar con nuestro asistente a través de WhatsApp, conectar servicios externos o suscribirte a nuestros planes, aceptas cumplir y regirte por las siguientes Condiciones del Servicio.</p>

          <h2>1. Descripción del Servicio</h2>
          <p>Hermes TempleLabs proporciona un asistente automatizado con inteligencia artificial para la gestión de recordatorios, tareas, agendas y sincronización de calendarios vía WhatsApp.</p>

          <h2>2. Integración con Google Calendar</h2>
          <p>El servicio permite a los usuarios conectar su cuenta de Google Calendar mediante el protocolo estándar de autenticación OAuth 2.0. Al conectar tu cuenta, autorizas a Hermes TempleLabs a leer eventos existentes y crear nuevos eventos únicamente bajo tus instrucciones explícitas.</p>

          <h2>3. Planes y Pagos (Hermes TempleLabs Pro)</h2>
          <p>Ofrecemos planes gratuitos y suscripciones premium (Hermes TempleLabs Pro). Las suscripciones se procesan mediante pasarelas de pago certificadas (como Mercado Pago) de forma recurrente y pueden ser canceladas en cualquier momento por el usuario sin penalidad.</p>

          <h2>4. Uso Aceptable</h2>
          <p>Te comprometes a utilizar el servicio de manera lícita, absteniéndote de enviar contenido abusivo, spam, o que vulnere derechos de propiedad intelectual de terceros.</p>

          <h2>5. Modificaciones del Servicio</h2>
          <p>Nos reservamos el derecho de actualizar o modificar estas condiciones periódicamente para reflejar mejoras operativas o regulatorias.</p>

          <div class="footer">
            <div>© 2026 TempleLabs. Todos los derechos reservados.</div>
            <div>
              <a href="/privacy">Política de Privacidad</a>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}
