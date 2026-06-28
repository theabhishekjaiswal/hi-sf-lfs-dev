/**
 * SF Navigator v2.3 — Content Script
 *
 * Works on ANY Salesforce page: records, list views, home, setup, etc.
 *
 * NAVIGATION STRATEGY (researched from working extensions like Switch2Classic):
 *   Direct URL rewriting is the most reliable approach — no /ltng/switcher.
 *   Lightning → Classic:  swap domain + extract record ID into Classic path
 *   Classic  → Lightning: swap domain + build /lightning/r/{type}/{id}/view
 *   Non-record pages:     swap domain on the whole URL (best-effort)
 *
 * TOOLBAR PERSISTENCE (Lightning SPA fix):
 *   Lightning's Aura/LWC framework re-renders the DOM and removes injected
 *   elements. A MutationObserver watches for the toolbar being removed and
 *   reinjec ts it automatically (debounced to avoid thrashing).
 *
 * API CALLS: background.js reads `sid` cookie → Authorization: Bearer {sid}
 *   This bypasses CORS and the INVALID_SESSION_ID error from content scripts.
 */

(function () {
  'use strict';

  // ─── Guard: skip auth / API-only paths ───────────────────────────────────

  if (/^\/(secur\/|login|services\/|oauth2\/|setup\/secur)/i.test(window.location.pathname)) return;

  // ─── Constants ────────────────────────────────────────────────────────────

  const APP_OBJECT = 'genesis__Applications__c';
  const TOOLBAR_ID = 'sf-navigator-root';
  const SF_ID_RE   = /^[a-zA-Z0-9]{15,18}$/;

  // ─── Key prefix → object type (for Classic record IDs) ───────────────────

  const KEY_PREFIX = {
    '001': 'Account',
    '003': 'Contact',
    '006': 'Opportunity',
    '00Q': 'Lead',
    '500': 'Case',
    '00T': 'Task',
    '00U': 'Event',
    '01Z': 'Report',
    '00D': 'Organization',
  };

  // ─── VF page name → SObject type ─────────────────────────────────────────

  const VF_PAGE_MAP = {
    'applicationdetails':  APP_OBJECT,
    'application_details': APP_OBJECT,
    'applicationdetail':   APP_OBJECT,
    'genesisapplication':  APP_OBJECT,
    'applicationform':     APP_OBJECT,
    'genesis_application': APP_OBJECT,
  };

  // ─── Domain helpers ───────────────────────────────────────────────────────

  function getApiBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  function isOnLightningDomain() {
    return window.location.hostname.includes('.lightning.force.com');
  }

  /**
   * Classic-compatible base URL.
   *   *.lightning.force.com  →  *.my.salesforce.com
   *   *.my.salesforce.com    →  unchanged
   *   cs*.salesforce.com     →  unchanged
   */
  function getClassicBase() {
    const { protocol, hostname } = window.location;
    const h = hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    return `${protocol}//${h}`;
  }

  /**
   * Lightning Experience base URL.
   *   *.my.salesforce.com        →  *.lightning.force.com
   *   *.lightning.force.com      →  unchanged
   *
   * Sandbox example:
   *   myorg--uat.sandbox.my.salesforce.com  →  myorg--uat.sandbox.lightning.force.com
   */
  function getLightningBase() {
    const { protocol, hostname } = window.location;
    if (hostname.includes('.lightning.force.com')) return `${protocol}//${hostname}`;
    const h = hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    // If no substitution happened (e.g. cs*.salesforce.com legacy pods), stay as-is
    return `${protocol}//${h}`;
  }

  // ─── Background API bridge ────────────────────────────────────────────────

  function bgQuery(query) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfQuery', baseUrl: getApiBaseUrl(), query },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (resp && resp.ok) return resolve(resp.data);
          reject(new Error((resp && resp.error) || 'Unknown error'));
        }
      );
    });
  }

  function bgFetch(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfFetch', url, baseUrl: getApiBaseUrl() },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (resp && resp.ok) return resolve(resp.data);
          reject(new Error((resp && resp.error) || 'Unknown error'));
        }
      );
    });
  }

  // ─── Page / record detection ──────────────────────────────────────────────

  function objectTypeFromId(id) {
    return (id && id.length >= 3) ? (KEY_PREFIX[id.substring(0, 3)] || null) : null;
  }

  /**
   * Parse the current page URL.
   * Returns { objectType, recordId, isLightning, isRecordPage }
   *
   * Handles:
   *   1. Lightning record URL:  /lightning/r/{ObjectType}/{Id}/view
   *   2. Classic record URL:    /{Id}
   *   3. VF / Apex page:        /apex/{PageName}?id={Id}
   *   4. Generic ?id= param:    any page with ?id={Id}
   *   5. Non-record page:       everything else (Classic/Lightning switch still shown)
   */
  function parsePage() {
    const { pathname, searchParams } = new URL(window.location.href);
    const onLEX = isOnLightningDomain();

    // 1. Lightning record: /lightning/r/ObjectApiName/RecordId/...
    const lexMatch = pathname.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//);
    if (lexMatch) {
      return {
        objectType:   lexMatch[1],
        recordId:     lexMatch[2],
        isLightning:  true,
        isRecordPage: true,
      };
    }

    // 2. Classic record path: /{RecordId} or /{RecordId}/e etc.
    const classicMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicMatch) {
      const id = classicMatch[1];
      // Guard against known non-record path words that happen to be 15-18 chars
      if (/^(setup|lightning|apex|visualforce|servlet|secur|partners)/i.test(id)) {
        return { objectType: null, recordId: null, isLightning: false, isRecordPage: false };
      }
      return {
        objectType:   objectTypeFromId(id),
        recordId:     id,
        isLightning:  false,
        isRecordPage: true,
      };
    }

    // 3. Apex / Visualforce: /apex/PageName?id=RecordId
    const apexMatch = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam   = searchParams.get('id');
    if (apexMatch && idParam && SF_ID_RE.test(idParam)) {
      const objectType = VF_PAGE_MAP[apexMatch[1].toLowerCase()] || null;
      return {
        objectType,
        recordId:     idParam,
        isLightning:  onLEX,   // respect domain even on VF pages
        isRecordPage: true,
      };
    }

    // 4. Generic ?id= fallback (any SF page with a record ID in the query string)
    if (idParam && SF_ID_RE.test(idParam)) {
      return {
        objectType:   objectTypeFromId(idParam),
        recordId:     idParam,
        isLightning:  onLEX,
        isRecordPage: true,
      };
    }

    // 5. Non-record page: show Classic / Lightning switch buttons only
    return { objectType: null, recordId: null, isLightning: onLEX, isRecordPage: false };
  }

  // ─── Object type resolver (for unknown Classic record IDs) ────────────────

  async function resolveObjectType(recordId) {
    try {
      const url  = `${getApiBaseUrl()}/services/data/v59.0/ui-api/records/${recordId}?fields=Id`;
      const data = await bgFetch(url);
      return (data && data.apiName) || null;
    } catch {
      return null;
    }
  }

  // ─── URL builders ─────────────────────────────────────────────────────────

  /**
   * Classic record URL for direct navigation (related-record buttons —
   * Account, Contact, Party). No override params added here.
   */
  function classicRecordUrl(id) {
    return `${getClassicBase()}/${id}`;
  }

  /**
   * Current page URL with ?nooverride=1, stripping conflicting override params.
   */
  function noOverrideUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('sfdc.override');
    url.searchParams.delete('sfdc_override');
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  /**
   * Build the "Switch to Classic" URL — DIRECT URL rewriting (most reliable).
   *
   * Pattern (used by Switch2Classic and proven working extensions):
   *   Record page:  swap domain to Classic base + /{recordId}?nooverride=1
   *   Other page:   swap domain on entire URL (best-effort)
   *
   * We do NOT use /ltng/switcher because:
   *   - It's an undocumented internal endpoint
   *   - Fails on Lightning-only orgs / certain configurations
   *   - Can cause redirect loops
   */
  function switchToClassicUrl(page) {
    const classicBase = getClassicBase();

    if (page && page.isRecordPage && page.recordId) {
      // Direct Classic record URL — plain, no override params
      return `${classicBase}/${page.recordId}`;
    }

    // Non-record page: rewrite domain, keep path + search
    if (isOnLightningDomain()) {
      // Try to map /lightning/o/{object}/list → /{object} (Classic list view)
      const listMatch = window.location.pathname.match(/\/lightning\/o\/([^/]+)\/list/);
      if (listMatch) {
        return `${classicBase}/${listMatch[1]}`;
      }
      return `${classicBase}/home/home.jsp`;
    }

    // Already on Classic domain — return as-is (no override manipulation)
    return `${classicBase}${window.location.pathname}${window.location.search}`;
  }

  /**
   * Build the "Switch to Lightning" URL — DIRECT URL rewriting (most reliable).
   *
   * Record page:  build /lightning/r/{objectType}/{recordId}/view
   * Other page:   swap domain, or fall back to Lightning home
   *
   * For records with unknown object type, Salesforce resolves it automatically
   * via /lightning/r/{recordId}/view (no object type needed — SF redirects).
   */
  function switchToLightningUrl(page) {
    const lightningBase = getLightningBase();

    if (page && page.isRecordPage && page.recordId) {
      if (page.objectType) {
        // Full Lightning record URL with known type
        return `${lightningBase}/lightning/r/${page.objectType}/${page.recordId}/view`;
      }
      // SF resolves the record ID to the correct object type automatically
      return `${lightningBase}/lightning/r/${page.recordId}/view`;
    }

    // Non-record page: rewrite domain on current path
    if (!isOnLightningDomain()) {
      // Try to convert Classic list/tab URL to Lightning equivalent
      const url = new URL(window.location.href);
      url.hostname = url.hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
      // Strip Classic-only params
      url.searchParams.delete('nooverride');
      url.searchParams.delete('sfdc.override');
      return url.toString();
    }

    // Already on Lightning
    return window.location.href;
  }

  // ─── Application data fetcher ─────────────────────────────────────────────

  async function fetchAppData(appId) {
    const result = { accountId: null, contactId: null, partyId: null, error: false };

    try {
      const data = await bgQuery(
        `SELECT genesis__Account__c, genesis__Contact__c FROM genesis__Applications__c WHERE Id = '${appId}'`
      );
      if (data.records && data.records.length > 0) {
        result.accountId = data.records[0].genesis__Account__c || null;
        result.contactId = data.records[0].genesis__Contact__c || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Account/Contact query failed:', e.message);
      result.error = true;
    }

    try {
      const data = await bgQuery(
        `SELECT Id FROM clcommon__Party__c WHERE genesis__Application__c = '${appId}' LIMIT 1`
      );
      if (data.records && data.records.length > 0) {
        result.partyId = data.records[0].Id || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Party query failed:', e.message);
    }

    return result;
  }

  // ─── SVG Icons ────────────────────────────────────────────────────────────

  const ICONS = {
    classic:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    lightning:  `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    nooverride: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    account:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    contact:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    party:      `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    openall:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    logo:       `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    spinner:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
  };

  // ─── DOM utilities ────────────────────────────────────────────────────────

  function makeButton({ id, icon, label, tooltip, variant, active, onClick }) {
    const btn = document.createElement('button');
    btn.id        = `sfn-btn-${id}`;
    btn.className = `sfn-btn sfn-btn--${variant}${active ? ' sfn-btn--active' : ''}`;
    btn.setAttribute('data-tooltip', tooltip);
    btn.innerHTML = `<span class="sfn-btn-icon">${icon}</span><span class="sfn-btn-label">${label}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setLoading(btn, on) {
    if (on) {
      btn._origIcon = btn.querySelector('.sfn-btn-icon').innerHTML;
      btn.classList.add('sfn-loading');
      btn.querySelector('.sfn-btn-icon').innerHTML = ICONS.spinner;
    } else {
      btn.classList.remove('sfn-loading');
      if (btn._origIcon) btn.querySelector('.sfn-btn-icon').innerHTML = btn._origIcon;
    }
  }

  function markDisabled(btn, tooltip) {
    btn.disabled = true;
    if (tooltip) btn.setAttribute('data-tooltip', tooltip);
  }

  function createDivider() {
    const d = document.createElement('div');
    d.className = 'sfn-divider';
    return d;
  }

  // ─── Toolbar builder ──────────────────────────────────────────────────────

  function buildToolbar(page, appData, isLoading) {
    const isApp = page && page.objectType === APP_OBJECT;
    const onLEX = page ? page.isLightning : isOnLightningDomain();

    const root = document.createElement('div');
    root.id = TOOLBAR_ID;

    const toolbar = document.createElement('div');
    toolbar.id = 'sf-navigator-toolbar';

    // Logo
    const logo = document.createElement('div');
    logo.className = 'sfn-logo';
    logo.innerHTML = `<div class="sfn-logo-icon">${ICONS.logo}</div><span class="sfn-logo-text">SF Nav</span>`;
    toolbar.appendChild(logo);

    // Classic
    const classicBtn = makeButton({
      id:      'classic',
      icon:    ICONS.classic,
      label:   'Classic',
      tooltip: onLEX ? 'Open in Salesforce Classic' : 'Currently in Classic view',
      variant: 'classic',
      active:  !onLEX,
      onClick: () => window.open(switchToClassicUrl(page), '_blank'),
    });
    toolbar.appendChild(classicBtn);

    // Lightning
    const lightningBtn = makeButton({
      id:      'lightning',
      icon:    ICONS.lightning,
      label:   'Lightning',
      tooltip: !onLEX ? 'Open in Lightning Experience' : 'Currently in Lightning view',
      variant: 'lightning',
      active:  onLEX,
      onClick: () => window.open(switchToLightningUrl(page), '_blank'),
    });
    toolbar.appendChild(lightningBtn);

    // App-specific section
    if (isApp) {
      toolbar.appendChild(createDivider());

      const noOvrBtn = makeButton({
        id:      'nooverride',
        icon:    ICONS.nooverride,
        label:   'No Override',
        tooltip: 'Open with ?nooverride=1 (bypasses Visualforce page override)',
        variant: 'nooverride',
        onClick: () => window.open(noOverrideUrl(), '_blank'),
      });
      toolbar.appendChild(noOvrBtn);

      const accountBtn = makeButton({
        id:      'account',
        icon:    ICONS.account,
        label:   'Account',
        tooltip: 'Open related Account in Classic',
        variant: 'account',
        onClick: () => {
          if (appData && appData.accountId) window.open(classicRecordUrl(appData.accountId), '_blank');
        },
      });
      toolbar.appendChild(accountBtn);

      const contactBtn = makeButton({
        id:      'contact',
        icon:    ICONS.contact,
        label:   'Contact',
        tooltip: 'Open related Contact in Classic',
        variant: 'contact',
        onClick: () => {
          if (appData && appData.contactId) window.open(classicRecordUrl(appData.contactId), '_blank');
        },
      });
      toolbar.appendChild(contactBtn);

      const partyBtn = makeButton({
        id:      'party',
        icon:    ICONS.party,
        label:   'Party',
        tooltip: 'Open related Party in Classic',
        variant: 'party',
        onClick: () => {
          if (appData && appData.partyId) window.open(classicRecordUrl(appData.partyId), '_blank');
        },
      });
      toolbar.appendChild(partyBtn);

      toolbar.appendChild(createDivider());

      const openAllBtn = makeButton({
        id:      'openall',
        icon:    ICONS.openall,
        label:   'Open All',
        tooltip: 'Open No Override + Account + Contact + Party in new tabs',
        variant: 'openall',
        onClick: () => {
          window.open(noOverrideUrl(), '_blank');
          if (appData && appData.accountId) window.open(classicRecordUrl(appData.accountId), '_blank');
          if (appData && appData.contactId) window.open(classicRecordUrl(appData.contactId), '_blank');
          if (appData && appData.partyId)   window.open(classicRecordUrl(appData.partyId),   '_blank');
        },
      });
      toolbar.appendChild(openAllBtn);

      // Status dot
      const dot = document.createElement('div');
      dot.id        = 'sfn-status-dot';
      dot.className = `sfn-status-dot${isLoading ? ' sfn-status-dot--loading' : ''}`;
      dot.title     = isLoading ? 'Loading related records…' : 'Records loaded';
      toolbar.appendChild(dot);

      if (isLoading) {
        [accountBtn, contactBtn, partyBtn, openAllBtn].forEach((b) => setLoading(b, true));
      } else {
        if (!appData || !appData.accountId) {
          markDisabled(accountBtn, appData && appData.error
            ? 'Account lookup failed — check API Enabled permission'
            : 'No related Account found');
        }
        if (!appData || !appData.contactId) {
          markDisabled(contactBtn, appData && appData.error
            ? 'Contact lookup failed — check API Enabled permission'
            : 'No related Contact found');
        }
        if (!appData || !appData.partyId) {
          markDisabled(partyBtn, 'No related Party found');
        }
        if (appData && appData.error) {
          dot.classList.add('sfn-status-dot--error');
          dot.title = 'API error loading related records';
        }
      }
    }

    root.appendChild(toolbar);
    return root;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    if (document.getElementById(TOOLBAR_ID)) return;
    if (!document.body) return;

    const page = parsePage();

    // Resolve object type for Classic pages with unknown prefix
    if (page && page.isRecordPage && page.recordId && !page.objectType) {
      page.objectType = await resolveObjectType(page.recordId);
    }

    const isApp = page && page.objectType === APP_OBJECT;

    if (isApp) {
      document.body.appendChild(buildToolbar(page, null, true));
      const appData = await fetchAppData(page.recordId);
      const old = document.getElementById(TOOLBAR_ID);
      if (old) old.remove();
      document.body.appendChild(buildToolbar(page, appData, false));
    } else {
      document.body.appendChild(buildToolbar(page, null, false));
    }
  }

  // ─── SPA URL change detection ─────────────────────────────────────────────

  let lastUrl = location.href;

  function onUrlChange() {
    const cur = location.href;
    if (cur === lastUrl) return;
    lastUrl = cur;
    const el = document.getElementById(TOOLBAR_ID);
    if (el) el.remove();
    // Longer delay on Lightning — the SPA needs time to settle the DOM
    setTimeout(init, 600);
  }

  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      orig.apply(this, args);
      onUrlChange();
    };
  });

  window.addEventListener('popstate', onUrlChange);

  // ─── MutationObserver: reinject if Lightning removes the toolbar ───────────
  // Lightning's Aura/LWC framework re-renders the DOM, which removes injected
  // elements. We watch direct children of <body> and reinject if our toolbar
  // disappears, debounced to avoid thrashing during rapid renders.

  let _reinjectTimer = null;

  function scheduleReinject() {
    if (_reinjectTimer) return;
    _reinjectTimer = setTimeout(() => {
      _reinjectTimer = null;
      // Only reinject if URL hasn't changed (not a navigation event)
      if (!document.getElementById(TOOLBAR_ID) && location.href === lastUrl) {
        init();
      }
    }, 500);
  }

  const bodyObserver = new MutationObserver((mutations) => {
    // Only act on removal of direct body children (not subtree noise)
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.id === TOOLBAR_ID) {
          scheduleReinject();
          return;
        }
      }
    }
  });

  // Start observing once body is available
  function startObserver() {
    if (document.body) {
      bodyObserver.observe(document.body, { childList: true });
    } else {
      // body not yet available — wait for it
      new MutationObserver((_, obs) => {
        if (document.body) {
          obs.disconnect();
          bodyObserver.observe(document.body, { childList: true });
        }
      }).observe(document.documentElement, { childList: true });
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  startObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();