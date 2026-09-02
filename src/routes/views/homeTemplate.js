/**
 * Render Public Home / Landing Page for Hermes TempleLabs.
 * Fully compliant with Google OAuth Verification Guidelines.
 * @returns {string} HTML document
 */
export function renderHomePage() {
  return `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Hermes TempleLabs</title>
        <meta name="application-name" content="Hermes TempleLabs" />
        <meta name="apple-mobile-web-app-title" content="Hermes TempleLabs" />
        <meta property="og:site_name" content="Hermes TempleLabs" />
        <meta property="og:title" content="Hermes TempleLabs" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://hermes.templelabs.co" />
        <meta property="og:description" content="Hermes TempleLabs — Asistente Inteligente de Productividad en WhatsApp" />
        <meta name="description" content="Hermes TempleLabs — Asistente Inteligente de Productividad en WhatsApp y Segundo Cerebro en Tiempo Real." />
        <link rel="icon" type="image/png" href="/Logo.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          "name": "Hermes TempleLabs",
          "applicationCategory": "Productivity",
          "operatingSystem": "All",
          "url": "https://hermes.templelabs.co"
        }
        </script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            background: #09090b;
            color: #d4d4d8;
            line-height: 1.6;
            overflow-x: hidden;
          }
          nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            max-width: 1100px;
            margin: 0 auto;
            padding: 1.75rem 1.5rem;
          }
          .nav-brand {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            text-decoration: none;
            color: #ffffff;
            font-weight: 800;
            font-size: 1.25rem;
          }
          .nav-brand img {
            width: 38px;
            height: 38px;
            border-radius: 0.75rem;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: #000000;
            object-fit: cover;
          }
          .nav-links {
            display: flex;
            gap: 1.5rem;
            align-items: center;
          }
          .nav-links a {
            color: #a1a1aa;
            text-decoration: none;
            font-size: 0.9rem;
            font-weight: 500;
            transition: color 0.2s;
          }
          .nav-links a:hover {
            color: #ffffff;
          }
          .hero {
            max-width: 900px;
            margin: 4rem auto 3rem auto;
            text-align: center;
            padding: 0 1.5rem;
          }
          .badge-hero {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.4rem 1rem;
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid rgba(34, 197, 94, 0.25);
            border-radius: 9999px;
            color: #4ade80;
            font-size: 0.82rem;
            font-weight: 700;
            margin-bottom: 1.5rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .hero h1 {
            font-size: 3rem;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: -0.04em;
            line-height: 1.15;
            margin-bottom: 1.25rem;
          }
          .hero h1 span {
            background: linear-gradient(135deg, #ffffff 0%, #a1a1aa 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          .hero p {
            font-size: 1.2rem;
            color: #a1a1aa;
            margin-bottom: 2.25rem;
            max-width: 650px;
            margin-left: auto;
            margin-right: auto;
          }
          .btn-primary {
            display: inline-flex;
            align-items: center;
            gap: 0.6rem;
            background: #22c55e;
            color: #000000;
            text-decoration: none;
            font-weight: 700;
            font-size: 1.05rem;
            padding: 0.85rem 1.75rem;
            border-radius: 0.75rem;
            box-shadow: 0 0 25px rgba(34, 197, 94, 0.35);
            transition: all 0.2s;
          }
          .btn-primary:hover {
            background: #16a34a;
            transform: translateY(-2px);
            box-shadow: 0 0 35px rgba(34, 197, 94, 0.5);
          }
          .btn-primary svg {
            width: 22px;
            height: 22px;
            fill: currentColor;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            max-width: 1100px;
            margin: 3rem auto;
            padding: 0 1.5rem;
          }
          .card {
            background: #18181b;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 1rem;
            padding: 2rem;
            transition: border-color 0.2s;
          }
          .card:hover {
            border-color: rgba(255, 255, 255, 0.2);
          }
          .card .icon {
            font-size: 2rem;
            margin-bottom: 1rem;
          }
          .card h3 {
            font-size: 1.25rem;
            font-weight: 700;
            color: #ffffff;
            margin-bottom: 0.5rem;
          }
          .card p {
            color: #a1a1aa;
            font-size: 0.95rem;
          }
          .google-section {
            max-width: 1100px;
            margin: 4rem auto;
            padding: 0 1.5rem;
          }
          .google-box {
            background: linear-gradient(180deg, #18181b 0%, #121215 100%);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 1.25rem;
            padding: 2.5rem;
            position: relative;
            overflow: hidden;
          }
          .google-box::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #4285F4, #EA4335, #FBBC05, #34A853);
          }
          .google-box h2 {
            font-size: 1.6rem;
            font-weight: 800;
            color: #ffffff;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }
          .google-box p {
            color: #d4d4d8;
            font-size: 1rem;
            margin-bottom: 1.25rem;
          }
          .google-box ul {
            list-style: none;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 1rem;
            margin-top: 1.5rem;
          }
          .google-box li {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.06);
            padding: 1rem;
            border-radius: 0.75rem;
            font-size: 0.9rem;
            color: #a1a1aa;
          }
          .google-box li strong {
            color: #ffffff;
            display: block;
            margin-bottom: 0.25rem;
          }
          footer {
            max-width: 1100px;
            margin: 4rem auto 2rem auto;
            padding: 2rem 1.5rem 0 1.5rem;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1.5rem;
            font-size: 0.85rem;
            color: #71717a;
          }
          footer a {
            color: #a1a1aa;
            text-decoration: none;
            margin-left: 1.5rem;
          }
          footer a:hover {
            color: #ffffff;
          }
        </style>
      </head>
      <body>
        <nav>
          <a href="/" class="nav-brand">
            <img src="/Logo.png" alt="Hermes TempleLabs" />
            Hermes TempleLabs
          </a>
          <div class="nav-links">
            <a href="/privacy">Privacidad</a>
            <a href="/terms">Condiciones</a>
            <a href="https://wa.link/iekvou" class="btn-primary" style="padding: 0.5rem 1rem; font-size: 0.85rem;">Abrir WhatsApp</a>
          </div>
        </nav>

        <section class="hero">
          <div class="badge-hero">⚡ Asistente Inteligente en WhatsApp</div>
          <h1><span>Hermes TempleLabs</span><br/>Tu Segundo Cerebro en Tiempo Real</h1>
          <p><strong>Hermes TempleLabs</strong> es un asistente inteligente de productividad diseñado para organizar tu día, gestionar tareas y sincronizar tus citas de Google Calendar de forma natural mediante mensajes de texto y notas de voz en WhatsApp.</p>
          <a href="https://wa.link/iekvou" class="btn-primary">
            <svg viewBox="0 0 24 24">
              <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
            </svg>
            Probar Hermes TempleLabs en WhatsApp
          </a>
        </section>

        <div class="grid">
          <div class="card">
            <div class="icon">⏰</div>
            <h3>Recordatorios Inteligentes</h3>
            <p>Programa avisos puntuales, recurrentes o insistentes con lenguaje natural directamente desde tu chat habitual.</p>
          </div>
          <div class="card">
            <div class="icon">🌅</div>
            <h3>Morning Briefing Diario</h3>
            <p>Recibe cada mañana a tu hora preferida un resumen ejecutivo de tus tareas pendientes y compromisos del día.</p>
          </div>
          <div class="card">
            <div class="icon">🧠</div>
            <h3>Memoria Continua y Proyectos</h3>
            <p>Guarda contexto de clientes, personas y proyectos para que tu asistente aprenda y evolucione contigo.</p>
          </div>
        </div>

        <section class="google-section">
          <div class="google-box">
            <h2>
              <span>📅</span> Integración Oficial con Google Calendar
            </h2>
            <p><strong>Hermes TempleLabs</strong> se conecta de forma segura con la API de Google Calendar bajo el estándar OAuth 2.0 para potenciar tu productividad:</p>
            <ul>
              <li><strong>Lectura de eventos:</strong> Consultamos tu calendario únicamente cuando solicitas ver tu agenda o en la generación de tu <em>Morning Briefing</em>.</li>
              <li><strong>Creación de eventos:</strong> Añadimos eventos a tu Google Calendar sólo cuando tú lo pides explícitamente en el chat.</li>
              <li><strong>Detección de cruces:</strong> Te avisamos si una nueva tarea o reunión colisiona con un compromiso existente.</li>
              <li><strong>Privacidad y Uso Limitado:</strong> Cumplimos estrictamente con la Política de Datos de Usuario de los Servicios de la API de Google. Tus datos no se transfieren a terceros ni se emplean para publicidad.</li>
            </ul>
          </div>
        </section>

        <footer>
          <div>© 2026 TempleLabs. Todos los derechos reservados.</div>
          <div>
            <a href="/privacy">Política de Privacidad</a>
            <a href="/terms">Condiciones del Servicio</a>
          </div>
        </footer>
      </body>
    </html>
  `;
}
