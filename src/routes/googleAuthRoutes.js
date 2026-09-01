import express from 'express';
import { generateGoogleAuthUrl, exchangeGoogleCode } from '../services/googleAuth.js';
import { saveUserIntegration } from '../db/index.js';
import { sendReminderConfirmation } from '../utils/kapso.js';
import { getOrCreateUserByPhone } from '../db/users.js';

export const googleAuthRouter = express.Router();

/**
 * Route: GET /auth/google
 * Initiates the Google OAuth2 flow by redirecting the user to Google.
 */
googleAuthRouter.get('/', async (req, res) => {
  try {
    const userId = req.query.userId || req.query.user_id;
    const phone = req.query.phone || req.query.phoneNumber;

    let targetUserId = userId;

    if (!targetUserId && phone) {
      const user = await getOrCreateUserByPhone(phone);
      targetUserId = user.id;
    }

    if (!targetUserId) {
      return res.status(400).send('Error: user_id o phone_number es requerido para iniciar la autenticación con Google.');
    }

    const authUrl = generateGoogleAuthUrl({ userId: targetUserId, phoneNumber: phone });
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[googleAuthRouter] error generating auth url:', err);
    return res.status(500).send(`Error iniciando autenticación con Google: ${err.message}`);
  }
});

/**
 * Route: GET /auth/google/callback
 * Handles OAuth2 callback from Google, persists tokens and renders success page.
 */
googleAuthRouter.get('/callback', async (req, res) => {
  const { code, state, error: googleError } = req.query;

  if (googleError) {
    console.warn('[googleAuthRouter] User cancelled or Google returned error:', googleError);
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Conexión Cancelada — FiveLabs Reminder</title>
          <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Plus Jakarta Sans', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f172a; color: #f8fafc; padding: 1.5rem; text-align: center; }
            .card { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 1.5rem; padding: 2.5rem; max-width: 440px; width: 100%; }
            .btn { display: inline-block; margin-top: 1.5rem; background: #3b82f6; color: #fff; padding: 0.85rem 1.5rem; border-radius: 9999px; text-decoration: none; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1 style="font-size: 1.5rem; margin-bottom: 0.5rem;">Conexión Cancelada</h1>
            <p style="color: #94a3b8;">No se completó la vinculación con Google. Puedes volver a intentarlo cuando desees desde WhatsApp.</p>
            <a href="https://api.whatsapp.com/send" class="btn">Volver a WhatsApp</a>
          </div>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send('Error: Código de autorización no proporcionado.');
  }

  try {
    let userId = null;
    let phoneNumber = null;

    if (state) {
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
        userId = decoded.userId;
        phoneNumber = decoded.phoneNumber;
      } catch (parseErr) {
        console.warn('[googleAuthRouter] could not parse state payload:', parseErr.message);
      }
    }

    if (!userId) {
      return res.status(400).send('Error: Estado de sesión inválido o expirado.');
    }

    const { tokens, email, name } = await exchangeGoogleCode(code);

    await saveUserIntegration(userId, {
      provider: 'google',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      accountEmail: email,
      metadata: { displayName: name },
    });

    // Send confirmation message to WhatsApp if phone number is known
    if (phoneNumber) {
      const emailNotice = email ? ` (*${email}*)` : '';
      const whatsappMsg =
        `🎉 *¡Google Calendar conectado con éxito!*\n\n` +
        `Tu cuenta de Google${emailNotice} ha sido vinculada con FiveLabs Reminder.\n\n` +
        `A partir de ahora puedo:\n` +
        `• 📅 *Agendar eventos directamente en tu Google Calendar*\n` +
        `• 🔄 *Sincronizar tus eventos en el Morning Briefing diario*\n` +
        `• 🛡️ *Avisarte si tienes choques o cruces de horarios*\n\n` +
        `¿Qué compromiso deseas agendar? 🚀`;

      await sendReminderConfirmation(phoneNumber, whatsappMsg).catch(wErr => {
        console.warn('[googleAuthRouter] could not dispatch WhatsApp confirmation:', wErr.message);
      });
    }

    // Render beautiful confirmation page
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>¡Google Calendar Conectado! — FiveLabs Reminder</title>
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
              -webkit-backdrop-filter: blur(16px);
              border: 1px solid rgba(255, 255, 255, 0.1);
              border-radius: 1.5rem;
              padding: 2.5rem 2rem;
              max-width: 440px;
              width: 100%;
              text-align: center;
              box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(59, 130, 246, 0.15);
              animation: scaleUp 0.4s ease-out;
            }
            @keyframes scaleUp {
              from { opacity: 0; transform: scale(0.95); }
              to { opacity: 1; transform: scale(1); }
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
              box-shadow: 0 0 25px rgba(34, 197, 94, 0.4);
            }
            .icon-wrapper svg {
              width: 36px;
              height: 36px;
              stroke: #ffffff;
              stroke-width: 2.5;
            }
            .badge {
              display: inline-block;
              padding: 0.35rem 0.85rem;
              background: rgba(59, 130, 246, 0.15);
              border: 1px solid rgba(59, 130, 246, 0.3);
              border-radius: 9999px;
              font-size: 0.8rem;
              font-weight: 700;
              color: #60a5fa;
              letter-spacing: 0.05em;
              text-transform: uppercase;
              margin-bottom: 1rem;
            }
            h1 {
              font-size: 1.65rem;
              font-weight: 800;
              margin-bottom: 0.75rem;
              letter-spacing: -0.025em;
            }
            p {
              color: #94a3b8;
              font-size: 0.95rem;
              line-height: 1.5;
              margin-bottom: 1.75rem;
            }
            .account-pill {
              background: rgba(15, 23, 42, 0.6);
              border: 1px solid rgba(255, 255, 255, 0.08);
              border-radius: 0.75rem;
              padding: 0.75rem 1rem;
              font-size: 0.875rem;
              color: #cbd5e1;
              margin-bottom: 1.75rem;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 0.5rem;
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
              font-size: 1rem;
              padding: 0.95rem 1.5rem;
              border-radius: 1rem;
              transition: all 0.2s ease;
              box-shadow: 0 4px 15px rgba(37, 211, 102, 0.3);
            }
            .btn-whatsapp:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 20px rgba(37, 211, 102, 0.4);
            }
            .btn-whatsapp svg {
              width: 20px;
              height: 20px;
              fill: currentColor;
            }
            .footer {
              margin-top: 1.5rem;
              font-size: 0.75rem;
              color: #64748b;
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
            
            ${email ? `<div class="account-pill"><span>📧</span> <strong>${email}</strong></div>` : ''}

            <a href="https://api.whatsapp.com/send" class="btn-whatsapp">
              <svg viewBox="0 0 24 24">
                <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
              </svg>
              Volver a WhatsApp
            </a>
            <div class="footer">FiveLabs Reminder Assistant • Todos los derechos reservados</div>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[googleAuthRouter] callback processing error:', err);
    res.status(500).send(`Error procesando la autorización de Google: ${err.message}`);
  }
});
