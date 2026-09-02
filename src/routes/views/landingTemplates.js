/**
 * Render Google Calendar OAuth Connection Success Landing Page.
 * Supports modern 'obsidian' monochromatic theme and 'legacy' theme.
 *
 * @param {object} params
 * @param {string|null} [params.email]
 * @param {string} [params.theme='obsidian'] - 'obsidian' | 'legacy'
 * @returns {string} HTML document
 */
export function renderGoogleSuccessPage({ email = null, theme = 'obsidian' } = {}) {
  if (theme === 'legacy') {
    return renderLegacyGooglePage(email);
  }

  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Google Calendar Conectado — Hermes TempleLabs</title>
        <link rel="icon" type="image/png" href="/Logo.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at 50% 0%, #1e1e24 0%, #09090b 60%, #000000 100%);
            color: #ffffff;
            padding: 1.5rem;
            overflow-x: hidden;
          }
          .container {
            background: rgba(18, 18, 22, 0.85);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 1.75rem;
            padding: 2.75rem 2rem;
            max-width: 440px;
            width: 100%;
            text-align: center;
            box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.9), 0 0 50px rgba(255, 255, 255, 0.04);
            animation: scaleUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
          }
          @keyframes scaleUp {
            from { opacity: 0; transform: scale(0.94) translateY(12px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
          }
          .brand-logo-wrapper {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem auto;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.15);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 30px rgba(66, 133, 244, 0.2);
          }
          .brand-logo-wrapper svg {
            width: 40px;
            height: 40px;
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.35rem 0.9rem;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 9999px;
            font-size: 0.78rem;
            font-weight: 700;
            color: #e4e4e7;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 1.2rem;
          }
          .status-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #22c55e;
            box-shadow: 0 0 10px #22c55e;
          }
          h1 {
            font-size: 1.75rem;
            font-weight: 800;
            margin-bottom: 0.75rem;
            letter-spacing: -0.03em;
            color: #ffffff;
          }
          p {
            color: #a1a1aa;
            font-size: 0.95rem;
            line-height: 1.55;
            margin-bottom: 1.75rem;
          }
          .account-pill {
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 0.85rem;
            padding: 0.8rem 1rem;
            font-size: 0.88rem;
            color: #d4d4d8;
            margin-bottom: 1.75rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
          }
          .account-pill strong {
            color: #ffffff;
          }
          .btn-whatsapp {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.55rem;
            width: 100%;
            background: #ffffff;
            color: #000000;
            text-decoration: none;
            font-weight: 800;
            font-size: 1rem;
            padding: 1rem 1.5rem;
            border-radius: 1rem;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 20px rgba(255, 255, 255, 0.15);
          }
          .btn-whatsapp:hover {
            transform: translateY(-2px);
            background: #f4f4f5;
            box-shadow: 0 8px 30px rgba(255, 255, 255, 0.25);
          }
          .btn-whatsapp svg {
            width: 20px;
            height: 20px;
            fill: #25D366;
          }
          .footer {
            margin-top: 1.75rem;
            font-size: 0.75rem;
            color: #71717a;
            letter-spacing: 0.02em;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="brand-logo-wrapper">
            <svg viewBox="0 0 24 24">
              <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/>
              <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.24v3.15C3.26 21.36 7.33 24 12 24z"/>
              <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.24C.45 8.14 0 9.97 0 12s.45 3.86 1.24 5.42l4.04-3.15z"/>
              <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.24 6.58l4.04 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/>
            </svg>
          </div>
          <div class="status-badge">
            <span class="status-dot"></span>
            Google Calendar Conectado
          </div>
          <h1>¡Sincronización Exitosa!</h1>
          <p>Tu calendario de Google ahora está vinculado a tu segundo cerebro en WhatsApp.</p>
          
          ${email ? `<div class="account-pill"><span>📧</span> <strong>${email}</strong></div>` : ''}

          <a href="https://wa.link/iekvou" class="btn-whatsapp">
            <svg viewBox="0 0 24 24">
              <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
            </svg>
            Volver a WhatsApp
          </a>
          <div class="footer">Hermes TempleLabs • Todos los derechos reservados</div>
        </div>
      </body>
    </html>
  `;
}

/**
 * Render Subscription Success Landing Page.
 *
 * @param {object} [params]
 * @param {string} [params.theme='obsidian']
 * @returns {string} HTML document
 */
export function renderSubscriptionSuccessPage({ theme = 'obsidian' } = {}) {
  if (theme === 'legacy') {
    return renderLegacySubscriptionPage();
  }

  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>¡Suscripción Exitosa! — Hermes TempleLabs Pro</title>
        <link rel="icon" type="image/png" href="/Logo.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at 50% 0%, #1e1e24 0%, #09090b 60%, #000000 100%);
            color: #ffffff;
            padding: 1.5rem;
            overflow-x: hidden;
          }
          .container {
            background: rgba(18, 18, 22, 0.85);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 1.75rem;
            padding: 2.75rem 2rem;
            max-width: 440px;
            width: 100%;
            text-align: center;
            box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.9), 0 0 50px rgba(255, 255, 255, 0.04);
            animation: scaleUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
          }
          @keyframes scaleUp {
            from { opacity: 0; transform: scale(0.94) translateY(12px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
          }
          .crown-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem auto;
            border-radius: 50%;
            background: linear-gradient(135deg, rgba(234, 179, 8, 0.15) 0%, rgba(202, 138, 4, 0.05) 100%);
            border: 1px solid rgba(234, 179, 8, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2.5rem;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 30px rgba(234, 179, 8, 0.2);
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.35rem 0.9rem;
            background: rgba(234, 179, 8, 0.1);
            border: 1px solid rgba(234, 179, 8, 0.25);
            border-radius: 9999px;
            font-size: 0.78rem;
            font-weight: 700;
            color: #facc15;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 1.2rem;
          }
          h1 {
            font-size: 1.75rem;
            font-weight: 800;
            margin-bottom: 0.75rem;
            letter-spacing: -0.03em;
            color: #ffffff;
          }
          p {
            color: #a1a1aa;
            font-size: 0.95rem;
            line-height: 1.55;
            margin-bottom: 1.75rem;
          }
          .features-box {
            background: rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 1rem;
            padding: 1.25rem;
            margin-bottom: 1.75rem;
            text-align: left;
          }
          .feature-item {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            font-size: 0.88rem;
            color: #d4d4d8;
            margin-bottom: 0.6rem;
          }
          .feature-item:last-child {
            margin-bottom: 0;
          }
          .btn-whatsapp {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.55rem;
            width: 100%;
            background: #ffffff;
            color: #000000;
            text-decoration: none;
            font-weight: 800;
            font-size: 1rem;
            padding: 1rem 1.5rem;
            border-radius: 1rem;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 20px rgba(255, 255, 255, 0.15);
          }
          .btn-whatsapp:hover {
            transform: translateY(-2px);
            background: #f4f4f5;
            box-shadow: 0 8px 30px rgba(255, 255, 255, 0.25);
          }
          .btn-whatsapp svg {
            width: 20px;
            height: 20px;
            fill: #25D366;
          }
          .footer {
            margin-top: 1.75rem;
            font-size: 0.75rem;
            color: #71717a;
            letter-spacing: 0.02em;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="crown-icon">👑</div>
          <div class="status-badge">
            Hermes TempleLabs Pro Activo
          </div>
          <h1>¡Bienvenido a Pro!</h1>
          <p>Tu cuenta ahora tiene acceso ilimitado a todas las funciones avanzadas de tu asistente.</p>

          <div class="features-box">
            <div class="feature-item"><span>📅</span> Recordatorios para cualquier día y fecha</div>
            <div class="feature-item"><span>🔄</span> Recurrencias automáticas e intervalos</div>
            <div class="feature-item"><span>🌅</span> Morning briefing matutino en WhatsApp</div>
            <div class="feature-item"><span>🔔</span> Insistencia inteligente y confirmaciones</div>
          </div>

          <a href="https://wa.link/iekvou" class="btn-whatsapp">
            <svg viewBox="0 0 24 24">
              <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
            </svg>
            Volver a WhatsApp
          </a>
          <div class="footer">Hermes TempleLabs Assistant • Todos los derechos reservados</div>
        </div>
      </body>
    </html>
  `;
}

function renderLegacyGooglePage(email) {
  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>¡Google Calendar Conectado! — Hermes TempleLabs</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at top center, #1e1b4b 0%, #090d16 100%);
            color: #f8fafc;
            padding: 1.5rem;
          }
          .container {
            background: rgba(30, 41, 59, 0.7);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 1.5rem;
            padding: 2.5rem 2rem;
            max-width: 440px;
            width: 100%;
            text-align: center;
          }
          .icon-wrapper {
            width: 72px;
            height: 72px;
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem auto;
          }
          .icon-wrapper svg { width: 36px; height: 36px; stroke: #ffffff; stroke-width: 2.5; }
          .badge {
            display: inline-block;
            padding: 0.35rem 0.85rem;
            background: rgba(59, 130, 246, 0.15);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 9999px;
            font-size: 0.8rem;
            font-weight: 700;
            color: #60a5fa;
            margin-bottom: 1rem;
          }
          .btn-whatsapp {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            width: 100%;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            color: #ffffff;
            text-decoration: none;
            font-weight: 700;
            padding: 0.95rem 1.5rem;
            border-radius: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon-wrapper">
            <svg fill="none" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div class="badge">📅 Google Calendar Vinculado</div>
          <h1>¡Conexión Exitosa!</h1>
          <p>Tu calendario de Google ahora está conectado con tu asistente de WhatsApp.</p>
          <a href="https://wa.link/iekvou" class="btn-whatsapp">Volver a WhatsApp</a>
        </div>
      </body>
    </html>
  `;
}

function renderLegacySubscriptionPage() {
  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>¡Suscripción Exitosa! — Hermes TempleLabs Pro</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at top center, #1e1b4b 0%, #090d16 100%);
            color: #f8fafc;
            padding: 1.5rem;
          }
          .container {
            background: rgba(30, 41, 59, 0.7);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 1.5rem;
            padding: 2.5rem 2rem;
            text-align: center;
            max-width: 440px;
            width: 100%;
          }
          .badge {
            display: inline-block;
            padding: 0.35rem 0.85rem;
            background: rgba(34, 197, 94, 0.15);
            border: 1px solid rgba(34, 197, 94, 0.3);
            border-radius: 9999px;
            font-size: 0.8rem;
            font-weight: 700;
            color: #4ade80;
            margin-bottom: 1rem;
          }
          .btn-whatsapp {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            width: 100%;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            color: #ffffff;
            text-decoration: none;
            font-weight: 700;
            padding: 0.95rem 1.5rem;
            border-radius: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="badge">🌟 Hermes TempleLabs Pro Activo</div>
          <h1>¡Pago Confirmado!</h1>
          <p>Tu suscripción se ha procesado con éxito.</p>
          <a href="https://wa.link/iekvou" class="btn-whatsapp">Volver a WhatsApp</a>
        </div>
      </body>
    </html>
  `;
}
