/**
 * SF Navigator v2.2 — Content Script
 *
 * Works on ANY Salesforce page — records, list views, home, setup, etc.
 *
 * API CALLS: Routed through background.js which:
 *   - Reads the `sid` session cookie via chrome.cookies API
 *   - Makes requests with Authorization: Bearer {sid}
 *   - Background host_permissions bypass CORS (no INVALID_SESSION_ID)
 *
 * NAVIGATION: Uses Salesforce's /ltng/switcher endpoint which properly
 *   changes the user's interface mode (not just the URL), so switching
 *   works even when the org defaults to Lightning-only.
 */

(function () {
  'use strict';

  // ─── Guard: skip auth / API-only paths ───────────────────────────────────

  if (/^\/(secur\/|login|services\/|oauth2\/|setup\/secur)/i.test(window.location.pathname)) return;

  // ─── Constants ────────────────────────────────────────────────────────────

  const APP_OBJECT = 'genesis__Applications__c';
  const TOOLBAR_ID = 'sf-navigator-root';
  const SF_ID_RE   = /^[a-zA-Z0-9]{15,18}$/;

  // ─── Key prefix → object type (Classic record ID detection) ──────────────

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
  };

  // ─── Domain helpers ───────────────────────────────────────────────────────

  function getApiBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  /**
   * Classic-compatible base URL.
   * lightning.force.com  →  my.salesforce.com
   * Handles production and sandbox (my-domain) orgs.
   */
  function getClassicBase() {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com')}`;
  }

  /**
   * Lightning Experience base URL.
   * my.salesforce.com  →  lightning.force.com
   * Handles production and sandbox orgs.
   */
  function getLightningBase() {
    const { protocol, hostname } = window.location;
    if (hostname.includes('.lightning.force.com')) return `${protocol}//${hostname}`;
    const h = hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    return `${protocol}//${h}`;
  }

  function isOnLightningDomain() {
    return window.location.hostname.includes('.lightning.force.com');
  }

  // ─── Background API bridge ────────────────────────────────────────────────
  // All Salesforce REST calls go through background.js which reads the sid
  // cookie and uses it as Authorization: Bearer — bypasses CORS restrictions.

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

  // ─── Page detection ───────────────────────────────────────────────────────

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

    // 1. Lightning record: /lightning/r/ObjectType/RecordId/view
    const lexMatch = pathname.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//);
    if (lexMatch) {
      return { objectType: lexMatch[1], recordId: lexMatch[2], isLightning: true, isRecordPage: true };
    }

    // 2. Classic record path: /{RecordId}
    const classicMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicMatch) {
      const id = classicMatch[1];
      // Skip known non-record segments
      if (/^(setup|lightning|apex|visualforce|servlet|secur)/i.test(id)) {
        return { objectType: null, recordId: null, isLightning: false, isRecordPage: false };
      }
      return { objectType: objectTypeFromId(id), recordId: id, isLightning: false, isRecordPage: true };
    }

    // 3. Apex / Visualforce: /apex/PageName?id=RecordId
    const apexMatch = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam   = searchParams.get('id');
    if (apexMatch && idParam && SF_ID_RE.test(idParam)) {
      const objectType = VF_PAGE_MAP[apexMatch[1].toLowerCase()] || null;
      return { objectType, recordId: idParam, isLightning: false, isRecordPage: true };
    }

    // 4. Generic ?id= fallback
    if (idParam && SF_ID_RE.test(idParam)) {
      return { objectType: objectTypeFromId(idParam), recordId: idParam, isLightning: onLEX, isRecordPage: true };
    }

    // 5. Non-record page — show Classic/Lightning switch buttons only
    return { objectType: null, recordId: null, isLightning: onLEX, isRecordPage: false };
  }

  // ─── Object type resolver for Classic pages ───────────────────────────────

  async function resolveObjectType(recordId) {
    try {
      // Ask background to hit the UI API — it has the session cookie
      const url  = `${getApiBaseUrl()}/services/data/v59.0/ui-api/records/${recordId}?fields=Id`;
      const data = await bgFetch(url);
      return (data && data.apiName) || null;
    } catch {
      return null;
    }
  }

  // ─── URL builders — using /ltng/switcher for reliable view switching ───────

  /**
   * Classic record URL (used for related-record buttons which must always
   * open in Classic, not for the "switch view" buttons).
   */
  function classicRecordUrl(id) {
    return `${getClassicBase()}/${id}?nooverride=1`;
  }

  /**
   * No Override URL — strips sfdc.override and adds nooverride=1.
   */
  function noOverrideUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('sfdc.override');
    url.searchParams.delete('sfdc_override');
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  /**
   * "Switch to Classic" URL for any page.
   *
   * Uses /ltng/switcher?destination=classic which properly changes the
   * session's interface mode — not just the URL. This works even when
   * the org defaults to Lightning-only.
   *
   * The switcher always lives on the Classic (my.salesforce.com) domain.
   * The referrer tells Salesforce where to land after switching.
   */
  function switchToClassicUrl(page) {
    const classicBase = getClassicBase();

    let retUrl;
    if (page && page.isRecordPage && page.recordId) {
      // Land on the specific record in Classic (with nooverride)
      retUrl = `/${page.recordId}?nooverride=1`;
    } else {
      // Non-record page: try to land on the equivalent Classic path
      retUrl = window.location.pathname + window.location.search;
    }

    return `${classicBase}/ltng/switcher?destination=classic&referrer=${encodeURIComponent(retUrl)}`;
  }

  /**
   * "Switch to Lightning" URL for any page.
   *
   * Uses /ltng/switcher?destination=lex on the Classic domain which
   * properly changes the session's interface mode before redirecting.
   * The referrer is the Lightning URL to land on.
   */
  function switchToLightningUrl(page) {
    const classicBase   = getClassicBase();
    const lightningBase = getLightningBase();

    let retUrl;
    if (page && page.isRecordPage && page.recordId) {
      if (page.objectType) {
        // Known object type: land on the Lightning record page
        retUrl = `/lightning/r/${page.objectType}/${page.recordId}/view`;
      } else {
        // Unknown type: Lightning will resolve the record
        retUrl = `/lightning/r/${page.recordId}/view`;
      }
    } else {
      // Non-record page: try the Lightning home or equivalent path
      if (isOnLightningDomain()) {
        retUrl = window.location.pathname + window.location.search;
      } else {
        retUrl = '/lightning/page/home';
      }
    }

    // Switcher lives on the Classic domain for both directions
    return `${classicBase}/ltng/switcher?destination=lex&referrer=${encodeURIComponent(retUrl)}`;
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

    // ── Logo ─────────────────────────────────────────────────────────────────
    const logo = document.createElement('div');
    logo.className = 'sfn-logo';
    logo.innerHTML = `<div class="sfn-logo-icon">${ICONS.logo}</div><span class="sfn-logo-text">SF Nav</span>`;
    toolbar.appendChild(logo);

    // ── Classic ───────────────────────────────────────────────────────────────
    const classicBtn = makeButton({
      id:      'classic',
      icon:    ICONS.classic,
      label:   'Classic',
      tooltip: onLEX ? 'Switch to Salesforce Classic' : 'Currently in Classic view',
      variant: 'classic',
      active:  !onLEX,
      onClick: () => window.open(switchToClassicUrl(page), '_blank'),
    });
    toolbar.appendChild(classicBtn);

    // ── Lightning ─────────────────────────────────────────────────────────────
    const lightningBtn = makeButton({
      id:      'lightning',
      icon:    ICONS.lightning,
      label:   'Lightning',
      tooltip: !onLEX ? 'Switch to Lightning Experience' : 'Currently in Lightning view',
      variant: 'lightning',
      active:  onLEX,
      onClick: () => window.open(switchToLightningUrl(page), '_blank'),
    });
    toolbar.appendChild(lightningBtn);

    // ── Application-specific buttons (genesis__Applications__c only) ──────────
    if (isApp) {
      toolbar.appendChild(createDivider());

      // No Override
      const noOvrBtn = makeButton({
        id:      'nooverride',
        icon:    ICONS.nooverride,
        label:   'No Override',
        tooltip: 'Open with ?nooverride=1 (bypasses Visualforce page override)',
        variant: 'nooverride',
        onClick: () => window.open(noOverrideUrl(), '_blank'),
      });
      toolbar.appendChild(noOvrBtn);

      // Account
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

      // Contact
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

      // Party
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

      // Open All
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

      // Apply states
      if (isLoading) {
        [accountBtn, contactBtn, partyBtn, openAllBtn].forEach((b) => setLoading(b, true));
      } else {
        if (!appData || !appData.accountId) {
          markDisabled(accountBtn, appData && appData.error
            ? 'Account lookup failed — verify API access is enabled'
            : 'No related Account found');
        }
        if (!appData || !appData.contactId) {
          markDisabled(contactBtn, appData && appData.error
            ? 'Contact lookup failed — verify API access is enabled'
            : 'No related Contact found');
        }
        if (!appData || !appData.partyId) {
          markDisabled(partyBtn, 'No related Party found');
        }
        if (appData && appData.error) {
          dot.classList.add('sfn-status-dot--error');
          dot.title = 'API error — check Setup > Profiles > API Enabled';
        }
      }
    }

    root.appendChild(toolbar);
    return root;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const page = parsePage();

    // For Classic record pages with unknown prefix, resolve via UI API
    if (page && page.isRecordPage && page.recordId && !page.objectType) {
      page.objectType = await resolveObjectType(page.recordId);
    }

    const isApp = page && page.objectType === APP_OBJECT;

    if (isApp) {
      // Inject immediately with loading spinners on data-dependent buttons
      document.body.appendChild(buildToolbar(page, null, true));

      const appData = await fetchAppData(page.recordId);

      // Swap in the final state
      const old = document.getElementById(TOOLBAR_ID);
      if (old) old.remove();
      document.body.appendChild(buildToolbar(page, appData, false));
    } else {
      document.body.appendChild(buildToolbar(page, null, false));
    }
  }

  // ─── SPA navigation support (Lightning is a SPA) ──────────────────────────

  let lastUrl = location.href;

  function onUrlChange() {
    const cur = location.href;
    if (cur === lastUrl) return;
    lastUrl = cur;
    const el = document.getElementById(TOOLBAR_ID);
    if (el) el.remove();
    setTimeout(init, 450);
  }

  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      orig.apply(this, args);
      onUrlChange();
    };
  });

  window.addEventListener('popstate', onUrlChange);

  // ─── Boot ─────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();