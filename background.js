/**
 * SF Navigator — Background Service Worker (minimal stub)
 *
 * API calls are made directly from the content script (same-origin fetch
 * with credentials:include) — this is more reliable than a service worker
 * which doesn't inherit the tab's session cookies.
 *
 * This file is kept for potential future use (e.g., badge updates, context menus).
 */

// Keep the service worker alive (no-op install handler)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => {});
