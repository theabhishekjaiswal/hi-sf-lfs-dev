/**
 * SF Navigator — Background Service Worker v2.2
 *
 * WHY THIS EXISTS:
 *   Content scripts make fetch() with Origin: chrome-extension://... which
 *   Salesforce's CORS policy rejects — causing INVALID_SESSION_ID / 401 even
 *   when session cookies are present.
 *
 * HOW THIS FIXES IT:
 *   1. chrome.cookies.get() reads the Salesforce `sid` session cookie.
 *      (The sid value IS the OAuth access token / session ID.)
 *   2. fetch() is made from the background context with:
 *        Authorization: Bearer {sid}
 *   3. Background workers with host_permissions bypass CORS entirely —
 *      no preflight, no origin check. Request succeeds.
 */

'use strict';

// Per-hostname API version cache
const apiVersionCache = new Map();

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'sfQuery' || msg.type === 'sfFetch') {
    handleRequest(msg, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

// ─── Core request handler ─────────────────────────────────────────────────────

async function handleRequest(msg, sender) {
  // Use the actual tab URL as the base (most reliable source)
  const tabUrl  = sender.tab && sender.tab.url ? new URL(sender.tab.url) : null;
  const baseUrl = tabUrl
    ? `${tabUrl.protocol}//${tabUrl.hostname}`
    : msg.baseUrl;

  // Get session ID from cookies — this is the Salesforce Bearer token
  const sid = await getSid(baseUrl);

  const headers = { Accept: 'application/json' };
  if (sid) {
    headers['Authorization'] = `Bearer ${sid}`;
  }

  let url;
  if (msg.type === 'sfQuery') {
    const ver = await getApiVersion(baseUrl, headers);
    url = `${baseUrl}/services/data/${ver}/query?q=${encodeURIComponent(msg.query)}`;
  } else {
    // sfFetch: arbitrary URL (e.g. ui-api/records for object type resolution)
    url = msg.url;
  }

  const resp = await fetch(url, { headers });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json();
}

// ─── Session ID helper ────────────────────────────────────────────────────────

/**
 * Read the Salesforce session cookie for the given origin.
 * The `sid` cookie value equals the OAuth access token usable as Bearer auth.
 * chrome.cookies can read HttpOnly cookies — content scripts cannot.
 */
async function getSid(baseUrl) {
  try {
    const cookie = await chrome.cookies.get({ url: baseUrl, name: 'sid' });
    if (cookie && cookie.value) return cookie.value;
  } catch {}
  return null;
}

// ─── API version discovery ────────────────────────────────────────────────────

/**
 * Discover the highest available Salesforce REST API version for this org.
 * Result is cached per hostname — only one discovery call per org per session.
 */
async function getApiVersion(baseUrl, headers) {
  const hostname = new URL(baseUrl).hostname;
  if (apiVersionCache.has(hostname)) return apiVersionCache.get(hostname);

  try {
    const resp = await fetch(`${baseUrl}/services/data/`, { headers });
    if (resp.ok) {
      const list = await resp.json();
      if (Array.isArray(list) && list.length > 0) {
        const raw = list[list.length - 1].version; // e.g. "62.0"
        const ver = raw.startsWith('v') ? raw : `v${raw}`;
        apiVersionCache.set(hostname, ver);
        return ver;
      }
    }
  } catch {}

  return 'v59.0'; // safe fallback
}
