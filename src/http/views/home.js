import { existsSync } from 'node:fs';

/**
 * Render Public Home / Landing Page for Hermes TempleLabs.
 * Includes Google OAuth data-use disclosures and legal links.
 * @returns {string} HTML document
 */
export function renderHomePage() {
  // Keep a meaningful static example if either optimized export is unavailable.
  const demoReady = existsSync(new URL('../../../public/hermes-demo-loop.mp4', import.meta.url))
    && existsSync(new URL('../../../public/hermes-demo-loop-poster.jpg', import.meta.url));
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
        <meta name="description" content="Organiza tareas, recordatorios y tu agenda con Hermes TempleLabs desde WhatsApp." />
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
            overflow-wrap: anywhere;
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
            grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
            gap: 1.5rem;
            max-width: 1100px;
            margin: 3rem auto;
            padding: 0 1.5rem;
          }
          .card {
            min-width: 0;
            background: #18181b;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 1rem;
            padding: clamp(1.25rem, 4vw, 2rem);
            transition: border-color 0.2s;
          }
          .card:hover {
            border-color: rgba(255, 255, 255, 0.2);
          }
          .card .icon {
            font-size: 2rem;
            margin-bottom: 1rem;
          }
          .card h2 {
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
            min-width: 0;
            background: linear-gradient(180deg, #18181b 0%, #121215 100%);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 1.25rem;
            padding: clamp(1rem, 4vw, 2.5rem);
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
          .google-box a { color: #93c5fd; }
          .google-box p {
            color: #d4d4d8;
            font-size: 1rem;
            margin-bottom: 1.25rem;
          }
          .google-box ul {
            list-style: none;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
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
            color: #a1a1aa;
          }
          footer a {
            color: #a1a1aa;
            text-decoration: none;
            margin-left: 1.5rem;
          }
          footer a:hover {
            color: #ffffff;
          }
          a:focus-visible, button:focus-visible {
            outline: 3px solid #4ade80;
            outline-offset: 4px;
          }
          .btn-primary { max-width: 100%; justify-content: center; min-height: 44px; }
          .btn-primary svg { flex-shrink: 0; }
          .nav-links { flex-wrap: wrap; }
          .nav-links a { display: inline-flex; align-items: center; min-height: 44px; }
          .demo-section { max-width: 900px; margin: 3rem auto; padding: 0 1.5rem; }
          .demo-section h2 { color: #ffffff; font-size: 1.6rem; margin-bottom: 0.5rem; }
          .demo-section > p { margin-bottom: 1.5rem; color: #a1a1aa; }
          .demo-chat { padding: clamp(1rem, 4vw, 2rem); border: 1px solid #3f3f46; border-radius: 1rem; background: #080a0b; }
          .demo-media { position: relative; width: 100%; max-width: 640px; margin-inline: auto; aspect-ratio: 4 / 5; }
          /* Lighten lifts only channels below the page matte; foreground colors stay intact. */
          .demo-video, .demo-poster { display: block; width: 100%; height: 100%; aspect-ratio: 4 / 5; object-fit: contain; mix-blend-mode: lighten; mask-image: linear-gradient(90deg, transparent, #000 2%, #000 98%, transparent), linear-gradient(0deg, transparent, #000 min(8px, 2%), #000 calc(100% - min(8px, 2%)), transparent); -webkit-mask-composite: source-in; mask-composite: intersect; }
          .demo-section { background: #09090b; isolation: isolate; }
          .demo-caption { color: #a1a1aa; font-size: 0.85rem; margin: 0.75rem 0; }
          .demo-toggle { font: inherit; color: #d4d4d8; background: #18181b; border: 1px solid #3f3f46; border-radius: 0.5rem; padding: 0.5rem 1rem; min-height: 44px; cursor: pointer; }
          .demo-toggle[hidden], .demo-poster[hidden], .demo-video[hidden] { display: none; }
          .demo-summary { margin-top: 1rem; }
          .demo-summary summary { cursor: pointer; min-height: 44px; color: #a1a1aa; }
          .demo-chat header { display: flex; align-items: center; gap: 0.75rem; color: #ffffff; font-weight: 800; margin-bottom: 1.5rem; }
          .demo-chat header img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
          .demo-chat p { width: fit-content; max-width: 90%; padding: 1rem; border-radius: 1rem; margin-bottom: 1rem; }
          .demo-chat .request { background: #005c4b; color: #ffffff; margin-left: auto; }
          .demo-chat .reply { background: #202728; color: #ffffff; }
          .demo-chat p strong { display: block; }
          .demo-chat small { color: #a1a1aa; font-size: 0.85rem; }
          footer > div:last-child { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; }
          footer a { margin-left: 0; display: inline-flex; align-items: center; min-height: 44px; }
          @media (max-width: 700px) {
            nav { flex-wrap: wrap; gap: 1rem; }
            .nav-links { gap: 0.5rem 1rem; }
            .hero { margin-top: 2rem; }
            .hero h1 { font-size: clamp(2rem, 7vw, 3rem); }
            .hero p { font-size: 1rem; }
          }
          @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { transition: none !important; }
            .btn-primary:hover { transform: none; }
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
          <div class="badge-hero">Tu asistente en WhatsApp</div>
          <h1><span>Menos pendientes en la cabeza.</span><br/>Más claridad en tu día.</h1>
          <p>Organiza tareas, recordatorios y tu agenda con Hermes TempleLabs. Escríbele o envía una nota de voz desde WhatsApp.</p>
          <a href="https://wa.link/iekvou" class="btn-primary">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
            </svg>
            Probar Hermes en WhatsApp
          </a>
        </section>

        <main>
        <section class="demo-section" aria-labelledby="demo-title">
          <h2 id="demo-title">Un mensaje. Tu día más claro.</h2>
          <p>Una conversación de ejemplo: Morning Briefing, recordatorio a las 09:00 y Google Calendar, dentro del mismo chat.</p>
          ${demoReady ? `<figure>
            <div class="demo-media">
              <video class="demo-video" id="hermes-demo" width="640" height="800" controls loop muted playsinline preload="none" poster="/hermes-demo-loop-poster.jpg" aria-describedby="demo-caption" aria-label="Demo ilustrativa de recordatorios, agenda y Morning Briefing con Hermes, sin audio">
                <source src="/hermes-demo-loop.mp4" type="video/mp4" />
              </video>
              <img class="demo-poster" hidden src="/hermes-demo-loop-poster.jpg" width="640" height="800" alt="Morning Briefing: reunión de equipo a las 10:00 y pendiente de enviar propuesta." />
            </div>
            <figcaption class="demo-caption" id="demo-caption">Demo conceptual de Hermes · Sin audio · No es un chat en vivo.</figcaption>
            <button class="demo-toggle" id="demo-toggle" type="button" hidden aria-controls="hermes-demo" aria-pressed="false">Reproducir demo</button>
            <p id="demo-status" role="status" class="demo-caption"></p>
          </figure>
          <details class="demo-summary"><summary>Leer la conversación de ejemplo</summary>` : ''}
          <div class="demo-chat" role="group" aria-label="Resumen estático del ejemplo con Hermes">
            <header><img src="/Logo.png" alt="" />Hermes TempleLabs</header>
            <p class="request">¿Mi resumen de hoy?</p>
            <p class="reply"><strong>Morning Briefing</strong>10:00 · Equipo</p>
            <p class="reply">Pendiente: enviar propuesta.</p>
            <p class="request"><strong>Recordatorio</strong>A las 09:00, avísame: llamar a Ana.</p>
            <p class="reply">Listo. Te aviso a las 09:00.</p>
            <p class="reply">09:00 · Es hora de llamar a Ana.</p>
            <p class="request">¿Y mi reunión?</p>
            <p class="reply"><strong>Agenda con Hermes</strong>Google Calendar: 10:00 · Equipo</p>
          </div>
          ${demoReady ? '</details>' : ''}
        </section>

        <section aria-label="Herramientas para tu día" class="grid">
          <div class="card">
            <div class="icon">⏰</div>
            <h2>Recordatorios</h2>
            <p>Programa avisos puntuales o recurrentes para tus pendientes.</p>
          </div>
          <div class="card">
            <div class="icon">🌅</div>
            <h2>Tu resumen diario</h2>
            <p>Revisa tus tareas y compromisos en el Morning Briefing, a tu hora preferida.</p>
          </div>
          <div class="card">
            <div class="icon">🧠</div>
            <h2>Contexto y proyectos</h2>
            <p>Guarda información de tus proyectos para consultarla cuando la necesites.</p>
          </div>
        </section>

        <section class="google-section">
          <div class="google-box">
            <h2>
              Google Calendar: permisos y datos
            </h2>
            <p>La conexión con Google Calendar utiliza OAuth 2.0 y requiere tu autorización.</p>
            <ul>
              <li><strong>Lectura de eventos:</strong> Consultamos tu calendario únicamente cuando solicitas ver tu agenda o en la generación de tu <em>Morning Briefing</em>.</li>
              <li><strong>Creación de eventos:</strong> Añadimos eventos a tu Google Calendar sólo cuando tú lo pides explícitamente en el chat.</li>
              <li><strong>Privacidad y Uso Limitado:</strong> El uso y la transferencia de información recibida de Google se adhieren a su Política de Datos de Usuario de los Servicios de las APIs, incluidos los requisitos de Uso Limitado. No usamos estos datos para publicidad. Consulta los detalles en nuestra <a href="/privacy">Política de Privacidad</a>.</li>
            </ul>
          </div>
        </section>

        </main>
        <footer>
          <div>© 2026 TempleLabs. Todos los derechos reservados.</div>
          <div>
            <a href="/privacy">Política de Privacidad</a>
            <a href="/terms">Condiciones del Servicio</a>
          </div>
        </footer>
        ${demoReady ? `<script>
          (() => {
            const video = document.getElementById('hermes-demo');
            if (!window.IntersectionObserver) return; // Retain native controls without enhancement.
            const button = document.getElementById('demo-toggle');
            const status = document.getElementById('demo-status');
            const poster = video.parentElement.querySelector('.demo-poster');
            const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
            const connection = navigator.connection;
            let inView = false, pending = false, blocked = false, failed = false;
            let userIntent = null; // Only button clicks own explicit play/pause; lifecycle events never reset it.
            const eligible = () => inView && !document.hidden && !failed && userIntent !== false
              && (userIntent === true || (!motion.matches && !connection?.saveData && !blocked));
            const update = () => {
              button.textContent = video.paused ? 'Reproducir demo' : 'Pausar demo';
              button.setAttribute('aria-pressed', String(!video.paused));
            };
            const sync = () => {
              if (!eligible()) { video.pause(); update(); return; }
              if (!video.paused || pending) return;
              pending = true;
              video.muted = true;
              video.play().catch(() => {
                if (failed) return; // Media failure already owns the more specific guidance.
                blocked = true; if (userIntent !== false) userIntent = null;
                status.textContent = 'La reproducción automática no está disponible. Pulsa Reproducir demo.';
              }).finally(() => { pending = false; if (!eligible()) video.pause(); update(); });
            };
            const fallback = () => {
              failed = true; video.pause(); video.hidden = true; poster.hidden = false;
              status.textContent = 'No se pudo cargar el video. Puedes leer el ejemplo o volver a intentar reproducirlo.';
              update();
            };
            button.addEventListener('click', () => {
              userIntent = video.paused && !pending;
              if (userIntent) {
                blocked = false; status.textContent = '';
                if (failed) { failed = false; video.hidden = false; poster.hidden = true; video.load(); }
              }
              sync();
            });
            video.addEventListener('playing', () => { if (!eligible()) video.pause(); else status.textContent = ''; update(); });
            video.addEventListener('pause', update);
            video.addEventListener('error', fallback);
            video.querySelector('source').addEventListener('error', fallback);
            const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting && entry.intersectionRatio >= 0.15; sync(); }, { threshold: [0, 0.15] });
            observer.observe(video.parentElement);
            document.addEventListener('visibilitychange', sync);
            motion.addEventListener('change', sync);
            connection?.addEventListener('change', sync);
            video.controls = false;
            button.hidden = false;
            update();
          })();
        </script>` : ''}
      </body>
    </html>
  `;
}
