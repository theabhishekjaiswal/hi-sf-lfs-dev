/**
 * SF Navigator — Background Service Worker v2.3
 *
 * KEY FIX for INVALID_SESSION_ID in Lightning:
 *   The Salesforce REST API must be called on the my.salesforce.com (Classic)
 *   domain, even when the user is browsing Lightning (lightning.force.com).
 *   The `sid` cookie valid for REST API lives on my.salesforce.com.
 *
 *   So we ALWAYS:
 *     1. Convert the API base URL to my.salesforce.com
 *     2. Read the `sid` cookie from my.salesforce.com
 *     3. Make API requests to my.salesforce.com with Bearer {sid}
 *     4. Background host_permissions bypass CORS — no preflight issues.
 */

'use strict';

// Per-hostname API version cache (keyed by Classic hostname)
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

// ─── Domain normalization ─────────────────────────────────────────────────────

/**
 * Always resolve to the Classic (my.salesforce.com) base URL for API calls.
 * The Salesforce REST API session cookie lives on the Classic domain.
 *
 *   myorg.lightning.force.com           → myorg.my.salesforce.com
 *   myorg.my.salesforce.com             → unchanged
 *   myorg--uat.sandbox.lightning.force.com → myorg--uat.sandbox.my.salesforce.com
 */
function toClassicBase(urlOrString) {
  const u = typeof urlOrString === 'string' ? new URL(urlOrString) : urlOrString;
  const hostname = u.hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  return `${u.protocol}//${hostname}`;
}

// ─── Core request handler ─────────────────────────────────────────────────────

async function handleRequest(msg, sender) {
  // Derive the tab's origin (most reliable), fall back to message payload
  const tabUrl = sender.tab && sender.tab.url ? new URL(sender.tab.url) : null;
  const rawBase = tabUrl
    ? `${tabUrl.protocol}//${tabUrl.hostname}`
    : (msg.baseUrl || '');

  // ALWAYS use the Classic/My-Domain base for API calls regardless of which
  // domain the tab is currently on (Lightning or Classic).
  const apiBase = toClassicBase(rawBase);

  // Get session ID from the Classic domain cookie
  const sid = await getSid(apiBase);

  const headers = { Accept: 'application/json' };
  if (sid) headers['Authorization'] = `Bearer ${sid}`;

  let url;
  if (msg.type === 'sfQuery') {
    const ver = await getApiVersion(apiBase, headers);
    url = `${apiBase}/services/data/${ver}/query?q=${encodeURIComponent(msg.query)}`;
  } else {
    // sfFetch: use the URL from content.js but rewrite to Classic domain
    url = toClassicBase(msg.url).replace(/\/\/$/, '') + new URL(msg.url).pathname + new URL(msg.url).search;
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
 * Read the Salesforce session cookie (`sid`) for the given origin.
 * chrome.cookies API can read HttpOnly cookies — content scripts cannot.
 * The sid value IS the OAuth Bearer token for the REST API.
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
 * Discover the highest available REST API version for this org.
 * Cached per Classic hostname.
 */
async function getApiVersion(apiBase, headers) {
  const hostname = new URL(apiBase).hostname;
  if (apiVersionCache.has(hostname)) return apiVersionCache.get(hostname);

  try {
    const resp = await fetch(`${apiBase}/services/data/`, { headers });
    if (resp.ok) {
      const list = await resp.json();
      if (Array.isArray(list) && list.length > 0) {
        const raw = list[list.length - 1].version;
        const ver = raw.startsWith('v') ? raw : `v${raw}`;
        apiVersionCache.set(hostname, ver);
        return ver;
      }
    }
  } catch {}

  return 'v59.0';
}
