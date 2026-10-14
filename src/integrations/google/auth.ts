import { google } from 'googleapis';
import { getUserIntegration, saveUserIntegration, deleteUserIntegration } from '../../infrastructure/database/index.js';
import { createGoogleAuth } from './google-auth.js';

type OAuthClient = InstanceType<typeof google.auth.OAuth2>;
type Auth = ReturnType<typeof createGoogleAuth<OAuthClient>>;
const service: Auth = createGoogleAuth<OAuthClient>({
  getEnvironment: () => process.env, now: () => Date.now(),
  createOAuthClient: (...args) => new google.auth.OAuth2(...args),
  getUserInfo: client => google.oauth2({ version: 'v2', auth: client }).userinfo.get(),
  getUserIntegration: ((...args: Parameters<typeof getUserIntegration>) => getUserIntegration(...args)) as unknown as Parameters<typeof createGoogleAuth<OAuthClient>>[0]['getUserIntegration'],
  saveUserIntegration: ((...args: Parameters<typeof saveUserIntegration>) => saveUserIntegration(...args)) as unknown as Parameters<typeof createGoogleAuth<OAuthClient>>[0]['saveUserIntegration'],
  deleteUserIntegration: ((...args: Parameters<typeof deleteUserIntegration>) => deleteUserIntegration(...args)) as unknown as Parameters<typeof createGoogleAuth<OAuthClient>>[0]['deleteUserIntegration'],
  logger: console,
});



export const getGoogleRedirectUri: Auth['getGoogleRedirectUri'] = service.getGoogleRedirectUri;
export const isGoogleAuthError: Auth['isGoogleAuthError'] = service.isGoogleAuthError;
export const hasUsableGoogleCredentials: Auth['hasUsableGoogleCredentials'] = service.hasUsableGoogleCredentials;
export const clearInvalidGoogleIntegration: Auth['clearInvalidGoogleIntegration'] = service.clearInvalidGoogleIntegration;
export const createOAuth2Client: Auth['createOAuth2Client'] = service.createOAuth2Client;
export const generateGoogleAuthUrl: Auth['generateGoogleAuthUrl'] = service.generateGoogleAuthUrl;
export const getGoogleConnectUrl: Auth['getGoogleConnectUrl'] = service.getGoogleConnectUrl;
export const exchangeGoogleCode: Auth['exchangeGoogleCode'] = service.exchangeGoogleCode;
export const getAuthenticatedGoogleClient: Auth['getAuthenticatedGoogleClient'] = service.getAuthenticatedGoogleClient;
export const revokeGoogleIntegration: Auth['revokeGoogleIntegration'] = service.revokeGoogleIntegration;
