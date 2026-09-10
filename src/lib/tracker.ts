// Client-side analytics + lead tracking. Posts events to the Google Apps Script
// backend. Every call here must be fire-and-forget: never block UI, never throw.

export type LeadData = { name: string; wa: string; email: string };

declare global {
  interface Window {
    activeTab?: string;
  }
}

const SID_KEY = 'ax_sid';
const UTM_KEY = 'ax_utm';
const QUEUE_KEY = 'ax_queue';
const QUEUE_MAX = 20;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function getSessionId(): string {
  try {
    let sid = localStorage.getItem(SID_KEY);
    if (!sid) {
      sid = Date.now().toString(36) + Math.random().toString(36).slice(2);
      localStorage.setItem(SID_KEY, sid);
    }
    return sid;
  } catch {
    return 'nosid';
  }
}

// Deterministic 2x32-bit string hash (no crypto API dependency), folded into
// a 7-char uppercase alphanumeric id. Not cryptographic — just a stable
// per-device fingerprint from coarse, non-PII signals.
function hashToId(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)) >>> 0;
  const combined = h1.toString(36) + h2.toString(36);
  const alnum = combined.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (alnum + '0000000').slice(0, 7);
}

let visitorIdCache: string | null = null;
function getVisitorId(): string {
  if (visitorIdCache) return visitorIdCache;
  try {
    const nav = navigator;
    const scr = screen;
    const parts = [
      nav.userAgent,
      nav.language,
      String(scr.width),
      String(scr.height),
      String(new Date().getTimezoneOffset()),
      String(nav.hardwareConcurrency || 0),
    ].join('|');
    visitorIdCache = hashToId(parts);
  } catch {
    visitorIdCache = 'UNKNOWN';
  }
  return visitorIdCache;
}

// UTM params are only present on the landing URL; stash them in sessionStorage
// so later track() calls (after client-side nav, tab switches, etc.) still
// attribute back to the original campaign.
function captureUtm(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const utm_source = params.get('utm_source');
    const utm_medium = params.get('utm_medium');
    const utm_campaign = params.get('utm_campaign');
    if (utm_source || utm_medium || utm_campaign) {
      sessionStorage.setItem(
        UTM_KEY,
        JSON.stringify({ utm_source: utm_source || '', utm_medium: utm_medium || '', utm_campaign: utm_campaign || '' })
      );
    }
  } catch {
    // sessionStorage unavailable (private mode, etc.) — skip silently
  }
}

function getUtm(): { utm_source: string; utm_medium: string; utm_campaign: string } {
  try {
    const raw = sessionStorage.getItem(UTM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        utm_source: parsed.utm_source || '',
        utm_medium: parsed.utm_medium || '',
        utm_campaign: parsed.utm_campaign || '',
      };
    }
  } catch {
    // ignore
  }
  return { utm_source: '', utm_medium: '', utm_campaign: '' };
}

function getQueue(): Record<string, unknown>[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setQueue(items: Record<string, unknown>[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-QUEUE_MAX)));
  } catch {
    // ignore
  }
}

function enqueueFailed(payload: Record<string, unknown>): void {
  const q = getQueue();
  q.push(payload);
  setQueue(q);
}

// Content-Type text/plain keeps this a CORS "simple request" so the browser
// skips the preflight OPTIONS call — Apps Script web apps don't handle OPTIONS,
// so a preflight would silently fail every event. Apps Script still reads the
// raw body as JSON via e.postData.contents regardless of the declared type.
function sendPayload(url: string, payload: Record<string, unknown>): void {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    enqueueFailed(payload);
  });
}

function flushQueue(url: string): void {
  const q = getQueue();
  if (!q.length) return;
  setQueue([]);
  q.forEach((payload) => sendPayload(url, payload));
}

if (isBrowser()) {
  window.activeTab = window.activeTab || 'outstation';
  captureUtm();
}

/**
 * Fire-and-forget analytics/lead event. Never awaited by callers, never
 * throws, no-ops entirely (including on the server) if the tracker URL
 * isn't configured.
 */
export function track(event: string, extra?: string, leadData?: LeadData): void {
  if (!isBrowser()) return;

  const url = import.meta.env.PUBLIC_TRACKER_URL as string | undefined;
  if (!url) return;

  try {
    const utm = getUtm();
    const payload = {
      session_id: getSessionId(),
      visitor_id: getVisitorId(),
      event,
      segment: window.activeTab || 'outstation',
      lead_name: leadData?.name || '',
      lead_wa: leadData?.wa || '',
      lead_email: leadData?.email || '',
      extra: extra || '',
      page_source: window.location.pathname,
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      device: screen.width < 768 ? 'mobile' : 'desktop',
      referrer: document.referrer || '',
    };

    flushQueue(url);
    sendPayload(url, payload);
  } catch {
    // tracking must never break the page
  }
}
