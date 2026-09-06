import express from 'express';
import { generateGoogleAuthUrl, exchangeGoogleCode } from '../../integrations/google/auth.js';
import { saveUserIntegration } from '../../infrastructure/database/index.js';
import { sendReminderConfirmation } from '../../integrations/whatsapp/kapso-client.js';
import { getOrCreateUserByPhone } from '../../infrastructure/database/users.js';
import { renderGoogleSuccessPage } from '../views/landing.js';

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
          <title>Conexión Cancelada — Hermes TempleLabs</title>
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
            <a href="https://wa.link/iekvou" class="btn">Volver a WhatsApp</a>
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
        `Tu cuenta de Google${emailNotice} ha sido vinculada con Hermes TempleLabs.\n\n` +
        `A partir de ahora puedo:\n` +
        `• 📅 *Agendar eventos directamente en tu Google Calendar*\n` +
        `• 🔄 *Sincronizar tus eventos en el Morning Briefing diario*\n` +
        `• 🛡️ *Avisarte si tienes choques o cruces de horarios*\n\n` +
        `¿Qué compromiso deseas agendar? 🚀`;

      await sendReminderConfirmation(phoneNumber, whatsappMsg).catch(wErr => {
        console.warn('[googleAuthRouter] could not dispatch WhatsApp confirmation:', wErr.message);
      });
    }

    const theme = req.query.theme || 'obsidian';
    res.status(200).send(renderGoogleSuccessPage({ email, theme }));
  } catch (err) {
    console.error('[googleAuthRouter] callback processing error:', err);
    res.status(500).send(`Error procesando la autorización de Google: ${err.message}`);
  }
});

/**
 * Route: GET /auth/google/preview
 * Direct preview of the success landing page with "Volver a WhatsApp" button.
 */
googleAuthRouter.get('/preview', (req, res) => {
  const mockEmail = req.query.email || 'tu-correo@gmail.com';
  const theme = req.query.theme || 'obsidian';
  res.status(200).send(renderGoogleSuccessPage({ email: mockEmail, theme }));
});
