import { createLandingPages } from './landing-pages.js';
export { DEFAULT_HERMES_PHONE } from './landing-pages.js';
const view = createLandingPages({ getEnv: () => process.env});
export function getWhatsAppReturnUrl(...args: Parameters<typeof view.getWhatsAppReturnUrl>) { return view.getWhatsAppReturnUrl(...args); }
export function renderGoogleSuccessPage(...args: Parameters<typeof view.renderGoogleSuccessPage>) { return view.renderGoogleSuccessPage(...args); }
export function renderSubscriptionSuccessPage(...args: Parameters<typeof view.renderSubscriptionSuccessPage>) { return view.renderSubscriptionSuccessPage(...args); }


