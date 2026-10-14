import { existsSync } from 'node:fs';
import { createHomePage } from './home-page.js';
const assets = new URL(import.meta.url.includes('/dist/runtime/') ? '../../../../public/' : '../../../public/', import.meta.url);
const view = createHomePage({ demoAssetsAvailable: () => existsSync(new URL('hermes-demo-loop.mp4', assets)) && existsSync(new URL('hermes-demo-loop-poster.jpg', assets))});
export function renderHomePage() { return view.renderHomePage(); }


