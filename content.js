/**
 * SF Navigator v2.4 — Content Script
 *
 * Fixes in this version:
 *   1. API in Lightning — background now uses my.salesforce.com for all API calls
 *   2. Classic → Lightning "page not found" — fallback to one/one.app URL for
 *      records whose object type can't be resolved
 *   3. Toolbar not visible in Lightning — MutationObserver on documentElement +
 *      debounced URL-change handler prevent toolbar from being lost on re-renders
 *   4. Application related records — Account / Contact / Party buttons open in
 *      the SAME view (Lightning/Classic) as the Application is currently in
 */

(function () {
  'use strict';

  // ─── Guard: skip auth / API-only paths ───────────────────────────────────

  if (/^\/(secur\/|login|services\/|oauth2\/|setup\/secur)/i.test(window.location.pathname)) return;

  // ─── Constants ────────────────────────────────────────────────────────────

  const APP_OBJECT = 'genesis__Applications__c';
  const PARTY_OBJECT = 'clcommon__Party__c';
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
   * Classic (my.salesforce.com) base URL.
   * Works for production and sandbox orgs with My Domain.
   */
  function getClassicBase() {
    const { protocol, hostname } = window.location;
    const h = hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    return `${protocol}//${h}`;
  }

  /**
   * Lightning Experience (lightning.force.com) base URL.
   * Works for production and sandbox orgs with My Domain.
   */
  function getLightningBase() {
    const { protocol, hostname } = window.location;
    if (hostname.includes('.lightning.force.com')) return `${protocol}//${hostname}`;
    const h = hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    return `${protocol}//${h}`;
  }

  // ─── Background API bridge ────────────────────────────────────────────────
  // background.js reads the `sid` cookie from my.salesforce.com and makes all
  // API requests there, even when the current tab is on lightning.force.com.

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
   * Parse the current URL and return page context.
   * Returns { objectType, recordId, isLightning, isRecordPage }
   */
  function parsePage() {
    const { pathname, searchParams } = new URL(window.location.href);
    const onLEX = isOnLightningDomain();

    // 1. Lightning record:  /lightning/r/{ObjectApiName}/{RecordId}/...
    const lexMatch = pathname.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//);
    if (lexMatch) {
      return {
        objectType:   lexMatch[1],
        recordId:     lexMatch[2],
        isLightning:  true,
        isRecordPage: true,
      };
    }

    // 2. Classic record path:  /{RecordId} or /{RecordId}/e etc.
    const classicMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicMatch) {
      const id = classicMatch[1];
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

    // 3. Apex / Visualforce:  /apex/{PageName}?id={RecordId}
    const apexMatch = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam   = searchParams.get('id');
    if (apexMatch && idParam && SF_ID_RE.test(idParam)) {
      const objectType = VF_PAGE_MAP[apexMatch[1].toLowerCase()] || null;
      return {
        objectType,
        recordId:     idParam,
        isLightning:  onLEX,
        isRecordPage: true,
      };
    }

    // 4. Generic ?id= fallback
    if (idParam && SF_ID_RE.test(idParam)) {
      return {
        objectType:   objectTypeFromId(idParam),
        recordId:     idParam,
        isLightning:  onLEX,
        isRecordPage: true,
      };
    }

    // 5. Non-record page
    return { objectType: null, recordId: null, isLightning: onLEX, isRecordPage: false };
  }

  // ─── Object type resolver ─────────────────────────────────────────────────

  async function resolveObjectType(recordId) {
    try {
      // background.js will use the Classic domain + discovered API version
      const url  = `${getApiBaseUrl()}/services/data/v59.0/ui-api/records/${recordId}?fields=Id`;
      const data = await bgFetch(url);
      return (data && data.apiName) || null;
    } catch {
      return null;
    }
  }

  // ─── URL builders ─────────────────────────────────────────────────────────

  /**
   * No Override URL — strips sfdc.override and adds nooverride=1.
   * ONLY used by the No Override button and Open All. Never called elsewhere.
   */
  function noOverrideUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('sfdc.override');
    url.searchParams.delete('sfdc_override');
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  /**
   * "Switch to Classic" — DIRECT domain swap (most reliable).
   * Record page: swap domain → /{id}  (plain Classic URL)
   * Non-record:  swap domain or land on Classic home
   */
  function switchToClassicUrl(page) {
    const classicBase = getClassicBase();

    if (page && page.isRecordPage && page.recordId) {
      return `${classicBase}/${page.recordId}`;
    }

    if (isOnLightningDomain()) {
      // List view: /lightning/o/{Object}/list → /{Object}
      const listMatch = window.location.pathname.match(/\/lightning\/o\/([^/]+)\/list/);
      if (listMatch) return `${classicBase}/${listMatch[1]}`;
      return `${classicBase}/home/home.jsp`;
    }

    return `${classicBase}${window.location.pathname}${window.location.search}`;
  }

  /**
   * "Switch to Lightning" — DIRECT domain swap (most reliable).
   *
   * Record with known type:   /lightning/r/{type}/{id}/view
   * Record with unknown type: one/one.app#/sObject/{id}/view
   *   (Salesforce auto-resolves the record type from ID in this older URL format)
   * Non-record Classic page:  domain swap on current URL
   */
  function switchToLightningUrl(page) {
    const lightningBase = getLightningBase();

    if (page && page.isRecordPage && page.recordId) {
      if (page.objectType) {
        return `${lightningBase}/lightning/r/${page.objectType}/${page.recordId}/view`;
      }
      // Unknown type — use the sObject URL which works without knowing the type
      return `${lightningBase}/one/one.app#/sObject/${page.recordId}/view`;
    }

    if (!isOnLightningDomain()) {
      const url = new URL(window.location.href);
      url.hostname = url.hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
      url.searchParams.delete('nooverride');
      url.searchParams.delete('sfdc.override');
      return url.toString();
    }

    return window.location.href;
  }

  /**
   * Build a URL to open a related record (Account / Contact / Party)
   * in the SAME view (Lightning or Classic) as the current Application page.
   *
   * @param {string}  id          — Salesforce record ID
   * @param {boolean} inLightning — true if Application is in Lightning view
   * @param {string}  [objectType] — known object API name (e.g. 'Account')
   */
  function relatedRecordUrl(id, inLightning, objectType) {
    if (!id) return null;
    if (inLightning) {
      if (objectType) {
        return `${getLightningBase()}/lightning/r/${objectType}/${id}/view`;
      }
      // Fallback: one.app resolves type from ID
      return `${getLightningBase()}/one/one.app#/sObject/${id}/view`;
    }
    return `${getClassicBase()}/${id}`;
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

    // Classic button
    toolbar.appendChild(makeButton({
      id:      'classic',
      icon:    ICONS.classic,
      label:   'Classic',
      tooltip: onLEX ? 'Open in Salesforce Classic' : 'Currently in Classic view',
      variant: 'classic',
      active:  !onLEX,
      onClick: () => window.open(switchToClassicUrl(page), '_blank'),
    }));

    // Lightning button
    toolbar.appendChild(makeButton({
      id:      'lightning',
      icon:    ICONS.lightning,
      label:   'Lightning',
      tooltip: !onLEX ? 'Open in Lightning Experience' : 'Currently in Lightning view',
      variant: 'lightning',
      active:  onLEX,
      onClick: () => window.open(switchToLightningUrl(page), '_blank'),
    }));

    // ── Application-specific section ─────────────────────────────────────────
    if (isApp) {
      toolbar.appendChild(createDivider());

      // No Override — always on current page URL, both views
      toolbar.appendChild(makeButton({
        id:      'nooverride',
        icon:    ICONS.nooverride,
        label:   'No Override',
        tooltip: 'Open with ?nooverride=1 (bypasses Visualforce page override)',
        variant: 'nooverride',
        onClick: () => window.open(noOverrideUrl(), '_blank'),
      }));

      // Account — opens in SAME view as current Application
      const accountBtn = makeButton({
        id:      'account',
        icon:    ICONS.account,
        label:   'Account',
        tooltip: `Open related Account in ${onLEX ? 'Lightning' : 'Classic'}`,
        variant: 'account',
        onClick: () => {
          const url = relatedRecordUrl(appData && appData.accountId, onLEX, 'Account');
          if (url) window.open(url, '_blank');
        },
      });
      toolbar.appendChild(accountBtn);

      // Contact — opens in SAME view as current Application
      const contactBtn = makeButton({
        id:      'contact',
        icon:    ICONS.contact,
        label:   'Contact',
        tooltip: `Open related Contact in ${onLEX ? 'Lightning' : 'Classic'}`,
        variant: 'contact',
        onClick: () => {
          const url = relatedRecordUrl(appData && appData.contactId, onLEX, 'Contact');
          if (url) window.open(url, '_blank');
        },
      });
      toolbar.appendChild(contactBtn);

      // Party — opens in SAME view; object type is always clcommon__Party__c
      const partyBtn = makeButton({
        id:      'party',
        icon:    ICONS.party,
        label:   'Party',
        tooltip: `Open related Party in ${onLEX ? 'Lightning' : 'Classic'}`,
        variant: 'party',
        onClick: () => {
          const url = relatedRecordUrl(appData && appData.partyId, onLEX, PARTY_OBJECT);
          if (url) window.open(url, '_blank');
        },
      });
      toolbar.appendChild(partyBtn);

      toolbar.appendChild(createDivider());

      // Open All — opens No Override + related records, respecting current view
      const openAllBtn = makeButton({
        id:      'openall',
        icon:    ICONS.openall,
        label:   'Open All',
        tooltip: 'Open No Override + Account + Contact + Party in new tabs',
        variant: 'openall',
        onClick: () => {
          window.open(noOverrideUrl(), '_blank');
          const acc = relatedRecordUrl(appData && appData.accountId, onLEX, 'Account');
          const con = relatedRecordUrl(appData && appData.contactId, onLEX, 'Contact');
          const pty = relatedRecordUrl(appData && appData.partyId, onLEX, PARTY_OBJECT);
          if (acc) window.open(acc, '_blank');
          if (con) window.open(con, '_blank');
          if (pty) window.open(pty, '_blank');
        },
      });
      toolbar.appendChild(openAllBtn);

      // Status dot
      const dot = document.createElement('div');
      dot.id        = 'sfn-status-dot';
      dot.className = `sfn-status-dot${isLoading ? ' sfn-status-dot--loading' : ''}`;
      dot.title     = isLoading ? 'Loading related records…' : 'Records loaded';
      toolbar.appendChild(dot);

      // Apply loading / disabled states
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

    // Resolve object type for Classic records with unknown prefix
    if (page && page.isRecordPage && page.recordId && !page.objectType) {
      page.objectType = await resolveObjectType(page.recordId);
    }

    const isApp = page && page.objectType === APP_OBJECT;

    if (isApp) {
      // Show immediately with spinners on data-dependent buttons
      document.body.appendChild(buildToolbar(page, null, true));
      const appData = await fetchAppData(page.recordId);
      const old = document.getElementById(TOOLBAR_ID);
      if (old) old.remove();
      document.body.appendChild(buildToolbar(page, appData, false));
    } else {
      document.body.appendChild(buildToolbar(page, null, false));
    }
  }

  // ─── SPA / Lightning navigation ───────────────────────────────────────────
  // Lightning fires many pushState events per navigation. Debounce so we only
  // call init() ONCE after the URL has settled.

  let lastUrl        = location.href;
  let _navTimer      = null;

  function onUrlChange() {
    const cur = location.href;
    if (cur === lastUrl) return;
    lastUrl = cur;

    // Remove existing toolbar immediately on navigation
    const el = document.getElementById(TOOLBAR_ID);
    if (el) el.remove();

    // Debounced re-init — wait for Lightning DOM to settle
    if (_navTimer) clearTimeout(_navTimer);
    _navTimer = setTimeout(() => {
      _navTimer = null;
      init();
    }, 700);
  }

  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      orig.apply(this, args);
      onUrlChange();
    };
  });

  window.addEventListener('popstate', onUrlChange);

  // ─── MutationObserver: survive Lightning DOM re-renders ───────────────────
  // Lightning's Aura/LWC framework can silently replace body children during
  // component re-renders. Watch for our toolbar being removed and reinject.
  // Observing document.documentElement covers both body and html-level changes.

  let _reinjectTimer = null;

  function scheduleReinject() {
    if (_reinjectTimer) return;
    _reinjectTimer = setTimeout(() => {
      _reinjectTimer = null;
      // Only reinject if we're still on the same URL (not a navigation event)
      if (!document.getElementById(TOOLBAR_ID) && location.href === lastUrl) {
        init();
      }
    }, 600);
  }

  const domObserver = new MutationObserver((mutations) => {
    if (document.getElementById(TOOLBAR_ID)) return; // still there, ignore
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.id === TOOLBAR_ID) {
          scheduleReinject();
          return;
        }
      }
    }
  });

  // Observe document.documentElement so we survive even full body replacements
  domObserver.observe(document.documentElement, { childList: true, subtree: false });

  // Also observe body once it exists (catches direct body-child removals)
  function observeBody() {
    if (document.body) {
      domObserver.observe(document.body, { childList: true });
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      observeBody();
      init();
    });
  } else {
    observeBody();
    init();
  }

})();