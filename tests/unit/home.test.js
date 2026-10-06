import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
import { existsSync } from 'node:fs';
import { renderHomePage } from '../../src/http/views/home.js';

describe('public Hermes landing', () => {
  beforeEach(() => existsSync.mockReset().mockReturnValue(false));

  it('keeps Spanish branding, WhatsApp and legal destinations', () => {
    const html = renderHomePage();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('src="/Logo.png"');
    expect(html.match(/href="https:\/\/wa.link\/iekvou"/g)).toHaveLength(2);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('OAuth 2.0');
    expect(html).toContain('Uso Limitado');
    expect(html).not.toContain('Integración Oficial');
    expect(html).not.toContain('Tus datos no se transfieren a terceros');
  });

  it('gives the demo, tools and permissions distinct roles', () => {
    const html = renderHomePage();
    expect(html).toContain('Un mensaje. Tu día más claro.');
    expect(html).toContain('aria-label="Resumen estático del ejemplo con Hermes"');
    expect(html).toContain('<strong>Recordatorio</strong>');
    expect(html).toContain('<strong>Agenda con Hermes</strong>');
    expect(html).toContain('<strong>Morning Briefing</strong>');
    expect(html).toContain('Google Calendar: 10:00 · Equipo');
    expect(html).toContain('¿Mi resumen de hoy?');
    expect(html).toContain('09:00 · Es hora de llamar a Ana.');
    expect(html).not.toContain('mañana a las 9');
    expect(html).not.toContain('notificación de Google');
    expect(html).toContain('Herramientas para tu día');
    expect(html).toContain('Google Calendar: permisos y datos');
    expect(html).not.toContain('purpose-section');
    expect(html).toContain('<header><img src="/Logo.png" alt="" />Hermes TempleLabs</header>');
    expect(html).not.toContain('Ejemplo ilustrativo');
    expect(html).not.toContain('Conversación ficticia · No es un chat en vivo');
    expect(html.match(/<main>/g)).toHaveLength(1);
    expect(html.match(/<section\b/g)).toHaveLength(html.match(/<\/section>/g).length);
  });

  it('uses shrinkable grids and wrapping navigation rather than document clipping', () => {
    const html = renderHomePage();
    expect(html).toContain('minmax(min(100%, 300px), 1fr)');
    expect(html).toContain('minmax(min(100%, 280px), 1fr)');
    expect(html).not.toContain('overflow-x: hidden');
    expect(html).toContain('nav { flex-wrap: wrap;');
    expect(html).toContain('overflow-wrap: anywhere');
    // Structural assertions do not certify browser geometry.
  });

  it('does not request missing public media exports', () => {
    const html = renderHomePage();
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<source');
    expect(html).toContain('class="demo-chat"');
    existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(renderHomePage()).not.toContain('<video');
  });

  it('reserves optimized media geometry and keeps native no-JS controls plus provenance', () => {
    existsSync.mockReturnValue(true);
    const html = renderHomePage();
    expect(html).toContain('controls loop muted playsinline preload="none"');
    expect(html).toContain('src="/hermes-demo-loop.mp4" type="video/mp4"');
    expect(html).toContain('poster="/hermes-demo-loop-poster.jpg"');
    expect(html).toContain('width="640" height="800"');
    expect(html).toContain('aspect-ratio: 4 / 5');
    expect(html).toContain('Demo conceptual de Hermes');
    expect(html).toContain('Leer la conversación de ejemplo');
    expect(html).toContain('type="button" hidden aria-controls="hermes-demo"');
    expect(html).not.toMatch(/autoplay|hermes-demo\.mp4|hermes-demo-poster\.png|\/Users\//);
    expect(existsSync.mock.calls[0][0].pathname).toMatch(/\/public\/hermes-demo-loop.mp4$/);
  });

  // Execute the shipped script with small media/lifecycle fakes, not a simulated browser.
  const setup = (reduced = false, saveData = false) => {
    existsSync.mockReturnValue(true);
    const target = (extra = {}) => ({ events: {}, addEventListener(name, fn) { this.events[name] = fn; }, ...extra });
    const poster = { hidden: true };
    const source = target();
    const button = target({ setAttribute: vi.fn(), hidden: true });
    const status = {};
    const video = target({ paused: true, controls: true, querySelector: () => source, parentElement: { querySelector: () => poster },
      play: vi.fn(function () { this.paused = false; this.events.playing(); return Promise.resolve(); }),
      pause: vi.fn(function () { this.paused = true; this.events.pause?.(); }), load: vi.fn() });
    const document = target({ hidden: false, getElementById: (id) => ({ 'hermes-demo': video, 'demo-toggle': button, 'demo-status': status })[id] });
    const motion = target({ matches: reduced });
    const connection = target({ saveData });
    let observe;
    const window = { matchMedia: () => motion, IntersectionObserver: class { constructor(fn) { observe = fn; } observe() {} } };
    const script = [...renderHomePage().matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    runInNewContext(script, { window, document, navigator: { connection }, IntersectionObserver: window.IntersectionObserver });
    return { video, button, status, poster, source, document, motion, view: (visible) => observe([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]) };
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  it('gates autoplay on visibility and preserves explicit pause across lifecycle callbacks', async () => {
    const h = setup();
    expect(h.video.play).not.toHaveBeenCalled();
    h.view(true); await settle();
    expect(h.button.textContent).toBe('Pausar demo');
    h.view(false); expect(h.video.paused).toBe(true);
    h.view(true); await settle();
    h.button.events.click();
    h.view(false); h.view(true); h.document.events.visibilitychange();
    expect(h.video.paused).toBe(true);
    h.button.events.click(); await settle();
    h.document.hidden = true; h.document.events.visibilitychange();
    expect(h.video.paused).toBe(true);
    h.document.hidden = false; h.document.events.visibilitychange(); await settle();
    expect(h.video.paused).toBe(false);
  });

  it.each([[true, false], [false, true]])('allows manual play without automatic motion (reduce=%s, saveData=%s)', async (reduce, saveData) => {
    const h = setup(reduce, saveData); h.view(true);
    expect(h.video.play).not.toHaveBeenCalled();
    h.button.events.click(); await settle();
    expect(h.video.paused).toBe(false);
    expect(h.button.setAttribute).toHaveBeenLastCalledWith('aria-pressed', 'true');
  });

  it('preserves media-failure guidance when a pending play rejects later, then permits manual retry', async () => {
    const h = setup(); let rejectPlay;
    h.video.play.mockImplementationOnce(() => new Promise((_, reject) => { rejectPlay = reject; }));
    h.view(true); h.source.events.error();
    const guidance = h.status.textContent;
    expect(guidance).toContain('No se pudo cargar el video');
    rejectPlay(new Error('Late play rejection')); await settle();
    expect(h.status.textContent).toBe(guidance);
    expect(h.poster.hidden).toBe(false); expect(h.video.hidden).toBe(true); expect(h.video.paused).toBe(true);
    h.button.events.click(); await settle();
    expect(h.video.load).toHaveBeenCalledOnce(); expect(h.video.hidden).toBe(false);
    expect(h.poster.hidden).toBe(true); expect(h.video.paused).toBe(false); expect(h.status.textContent).toBe('');
  });

  it('keeps a poster and retry control on media failure; blocked autoplay does not retry on observers', async () => {
    const h = setup(); h.video.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    h.view(true); await settle(); h.view(true);
    expect(h.video.play).toHaveBeenCalledTimes(1);
    expect(h.status.textContent).toContain('Pulsa Reproducir demo');
    h.source.events.error(); expect(h.poster.hidden).toBe(false); expect(h.video.hidden).toBe(true);
    h.button.events.click(); await settle();
    expect(h.video.load).toHaveBeenCalledOnce(); expect(h.video.hidden).toBe(false);
  });
});
