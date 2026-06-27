/**
 * SF Navigator — Background Service Worker (v2)
 *
 * Acts as a privileged API proxy for the content script.
 * Content scripts cannot reliably send authenticated fetch() calls to Salesforce
 * (CSP + SameSite cookie restrictions). The background worker has broader
 * network access and correctly forwards browser session cookies.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'sfQuery') {
    handleQuery(message.baseUrl, message.query)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    // Return true to keep the message channel open for the async response
    return true;
  }

  if (message.type === 'sfFetch') {
    handleFetch(message.url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function handleQuery(baseUrl, query) {
  const url = `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function handleFetch(url) {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}
