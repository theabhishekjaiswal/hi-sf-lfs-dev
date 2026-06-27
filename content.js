/**
 * SF Navigator v2.1 — Content Script
 *
 * Premium Salesforce navigation toolbar.
 * Works on ANY Salesforce page — record pages, list views, home, setup, etc.
 *
 * KEY ARCHITECTURE NOTE:
 *   All Salesforce REST API calls are made directly from the content script
 *   using fetch() with credentials:'include'. Content scripts run in the
 *   page's security context, so same-origin requests automatically include
 *   the browser's session cookies. Background service workers do NOT inherit
 *   tab session cookies — that's why the previous approach caused 401 errors.
 */

(function () {
  'use strict';

  // ─── Guard: skip login / OAuth / API-only paths ───────────────────────────

  const EXCLUDED_PATH_RE = /^\/(secur\/|login|services\/|oauth2\/|setup\/secur)/i;
  if (EXCLUDED_PATH_RE.test(window.location.pathname)) return;

  // ─── Constants ───────────────────────────────────────────────────────────

  const APP_OBJECT  = 'genesis__Applications__c';
  const TOOLBAR_ID  = 'sf-navigator-root';
  const SF_ID_RE    = /^[a-zA-Z0-9]{15,18}$/;

  // ─── Salesforce record-ID key-prefix → object type ───────────────────────
  // Used to identify object type for Classic URLs where it's not in the path.

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
    '01I': 'PermissionSet',
  };

  // ─── Visualforce page name → SObject type ────────────────────────────────

  const VF_PAGE_MAP = {
    'applicationdetails':  APP_OBJECT,
    'application_details': APP_OBJECT,
    'applicationdetail':   APP_OBJECT,
    'genesisapplication':  APP_OBJECT,
    'applicationform':     APP_OBJECT,
  };

  // ─── Cached API version ───────────────────────────────────────────────────

  let _apiVer = null;

  /**
   * Discover the highest available Salesforce REST API version.
   * Result is cached after the first call.
   * Falls back to v59.0 if discovery fails.
   */
  async function getApiVersion() {
    if (_apiVer) return _apiVer;
    try {
      const resp = await fetch(`${getApiBaseUrl()}/services/data/`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (resp.ok) {
        const list = await resp.json();
        if (Array.isArray(list) && list.length > 0) {
          const raw = list[list.length - 1].version; // e.g. "59.0"
          _apiVer = raw.startsWith('v') ? raw : 'v' + raw;
          return _apiVer;
        }
      }
    } catch {}
    _apiVer = 'v59.0';
    return _apiVer;
  }

  // ─── Domain helpers ───────────────────────────────────────────────────────

  /**
   * Base URL for API calls — always the current page's origin.
   * Content scripts make same-origin requests so cookies are sent correctly.
   */
  function getApiBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  /**
   * Classic-compatible base URL.
   * Rewrites lightning.force.com → my.salesforce.com so Classic links work in
   * both production and sandbox (my-domain) orgs.
   *
   *   myorg.lightning.force.com           → myorg.my.salesforce.com
   *   myorg--uat.sandbox.lightning.force.com → myorg--uat.sandbox.my.salesforce.com  (N/A usually)
   *   myorg.my.salesforce.com             → unchanged
   *   cs123.salesforce.com                → unchanged
   */
  function getClassicBase() {
    const { protocol, hostname } = window.location;
    const h = hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    return `${protocol}//${h}`;
  }

  /**
   * Lightning Experience base URL.
   * Rewrites my.salesforce.com → lightning.force.com.
   *
   *   myorg.my.salesforce.com                  → myorg.lightning.force.com
   *   myorg--uat.sandbox.my.salesforce.com      → myorg--uat.sandbox.lightning.force.com
   *   myorg.lightning.force.com                → unchanged
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

  // ─── Direct REST API (content-script fetch — same origin, cookies sent) ──

  /**
   * Run a SOQL query and return the parsed JSON result.
   * Uses content-script fetch to the same origin so session cookies are
   * automatically included — no OAuth or background worker needed.
   */
  async function sfQuery(soql) {
    const ver = await getApiVersion();
    const url = `${getApiBaseUrl()}/services/data/${ver}/query?q=${encodeURIComponent(soql)}`;
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 150)}`);
    }
    return resp.json();
  }

  /**
   * Fetch any Salesforce REST API URL and return parsed JSON.
   */
  async function sfFetch(url) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ─── Page / record detection ──────────────────────────────────────────────

  function objectTypeFromId(id) {
    if (!id || id.length < 3) return null;
    return KEY_PREFIX[id.substring(0, 3)] || null;
  }

  /**
   * Parse the current URL and return page context.
   *
   * Returns:
   *   { objectType, recordId, isLightning, isRecordPage }
   *
   * For non-record pages returns:
   *   { objectType: null, recordId: null, isLightning, isRecordPage: false }
   */
  function parsePage() {
    const url = new URL(window.location.href);
    const { pathname, searchParams } = url;
    const onLightningDomain = isOnLightningDomain();

    // 1. Lightning record: /lightning/r/ObjectType/RecordId/view
    const lexMatch = pathname.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//);
    if (lexMatch) {
      return {
        objectType:   lexMatch[1],
        recordId:     lexMatch[2],
        isLightning:  true,
        isRecordPage: true,
      };
    }

    // 2. Classic record path: /{RecordId} or /{RecordId}/edit etc.
    const classicMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicMatch) {
      const id = classicMatch[1];
      // Guard: skip known non-record paths that look like IDs
      if (/^(setup|lightning|apex|visualforce|servlet)/i.test(id)) {
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
    const apexMatch  = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam    = searchParams.get('id');
    if (apexMatch && idParam && SF_ID_RE.test(idParam)) {
      const objectType = VF_PAGE_MAP[apexMatch[1].toLowerCase()] || null;
      return {
        objectType,
        recordId:     idParam,
        isLightning:  false,
        isRecordPage: true,
      };
    }

    // 4. Generic ?id= fallback (any other SF page with a record ID param)
    if (idParam && SF_ID_RE.test(idParam)) {
      return {
        objectType:   objectTypeFromId(idParam),
        recordId:     idParam,
        isLightning:  onLightningDomain,
        isRecordPage: true,
      };
    }

    // 5. Not a record page — show Classic/Lightning switch buttons anyway
    return {
      objectType:   null,
      recordId:     null,
      isLightning:  onLightningDomain,
      isRecordPage: false,
    };
  }

  // ─── Object type resolver for Classic record pages ────────────────────────

  /**
   * When on a Classic record page and we don't know the object type from
   * the key-prefix, call the UI API to resolve it.
   * Falls back to null silently — Lightning button will use the sObject fallback.
   */
  async function resolveObjectType(recordId) {
    try {
      const ver  = await getApiVersion();
      const url  = `${getApiBaseUrl()}/services/data/${ver}/ui-api/records/${recordId}?fields=Id`;
      const data = await sfFetch(url);
      return (data && data.apiName) || null;
    } catch {
      return null;
    }
  }

  // ─── URL builders ─────────────────────────────────────────────────────────

  /** Classic URL for a specific record. Always uses Classic-compatible base. */
  function classicRecordUrl(id) {
    return `${getClassicBase()}/${id}?nooverride=1`;
  }

  /** Lightning URL for a record with a known object type. */
  function lightningRecordUrl(objectType, id) {
    return `${getLightningBase()}/lightning/r/${objectType}/${id}/view`;
  }

  /**
   * Current page URL with ?nooverride=1, removing any conflicting override params.
   * Per spec: strips sfdc.override / sfdc_override before setting nooverride=1.
   */
  function noOverrideUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('sfdc.override');
    url.searchParams.delete('sfdc_override');
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  /**
   * Build "Switch to Classic" URL for any page.
   *
   *   - Lightning record   → Classic domain + /{id}?nooverride=1
   *   - Non-record LEX page → Classic domain + /ltng/switcher?destination=classic
   *   - Already Classic    → noOverrideUrl() (safe no-op)
   */
  function switchToClassicUrl(page) {
    // Record page: navigate to the same record on Classic domain
    if (page && page.isRecordPage && page.recordId) {
      return classicRecordUrl(page.recordId);
    }

    // Non-record Lightning page: use Salesforce's own switcher
    if (isOnLightningDomain()) {
      const ref = encodeURIComponent(window.location.href);
      return `${getClassicBase()}/ltng/switcher?destination=classic&referrer=${ref}`;
    }

    // Already on Classic domain — just ensure nooverride
    return noOverrideUrl();
  }

  /**
   * Build "Switch to Lightning" URL for any page.
   *
   *   - Classic record with known type → /lightning/r/{type}/{id}/view
   *   - Classic record, type unknown   → /one/one.app#/sObject/{id}/view
   *   - Non-record Classic page        → /ltng/switcher?destination=lex
   *   - Already Lightning              → current URL (no-op click)
   */
  function switchToLightningUrl(page) {
    const lexBase = getLightningBase();

    // Record page
    if (page && page.isRecordPage && page.recordId) {
      if (page.objectType) {
        return lightningRecordUrl(page.objectType, page.recordId);
      }
      // Unknown type — use the sObject universal viewer
      return `${lexBase}/lightning/r/${page.recordId}/view`;
    }

    // Non-record Classic page → use switcher
    if (!isOnLightningDomain()) {
      const ref = encodeURIComponent(window.location.href);
      return `${lexBase}/ltng/switcher?destination=lex&referrer=${ref}`;
    }

    // Already Lightning — rebuild on lightning domain (handles edge cases)
    const url  = new URL(window.location.href);
    url.hostname = url.hostname.replace('.my.salesforce.com', '.lightning.force.com');
    return url.toString();
  }

  // ─── Application data fetcher ─────────────────────────────────────────────

  /**
   * Fetch Account, Contact, Party IDs for a genesis__Applications__c record.
   * All queries are made via the same-origin content-script fetch.
   */
  async function fetchAppData(appId) {
    const result = { accountId: null, contactId: null, partyId: null, error: false };

    // Account + Contact
    try {
      const data = await sfQuery(
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

    // Party
    try {
      const data = await sfQuery(
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

  /**
   * Build the toolbar DOM and return the root element.
   *
   * @param {object}  page       — from parsePage()
   * @param {object}  appData    — from fetchAppData() (null during loading)
   * @param {boolean} isLoading  — show spinners on app buttons
   */
  function buildToolbar(page, appData, isLoading) {
    const isApp    = page && page.objectType === APP_OBJECT;
    const onLEX    = page ? page.isLightning : isOnLightningDomain();

    const root = document.createElement('div');
    root.id = TOOLBAR_ID;

    const toolbar = document.createElement('div');
    toolbar.id = 'sf-navigator-toolbar';

    // ── Logo ─────────────────────────────────────────────────────────────────
    const logo = document.createElement('div');
    logo.className = 'sfn-logo';
    logo.innerHTML = `
      <div class="sfn-logo-icon">${ICONS.logo}</div>
      <span class="sfn-logo-text">SF Nav</span>
    `;
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

    // ── Application-specific buttons ──────────────────────────────────────────
    if (isApp) {
      toolbar.appendChild(createDivider());

      // No Override
      const noOvrBtn = makeButton({
        id:      'nooverride',
        icon:    ICONS.nooverride,
        label:   'No Override',
        tooltip: 'Open with ?nooverride=1 (bypasses Visualforce override)',
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
      dot.id = 'sfn-status-dot';
      dot.className = 'sfn-status-dot' + (isLoading ? ' sfn-status-dot--loading' : '');
      dot.title = isLoading ? 'Loading related records…' : 'Records loaded';
      toolbar.appendChild(dot);

      // ── Apply states based on loading / data ────────────────────────────────
      if (isLoading) {
        [accountBtn, contactBtn, partyBtn, openAllBtn].forEach((b) => setLoading(b, true));
      } else {
        if (!appData || !appData.accountId) {
          markDisabled(accountBtn, appData && appData.error
            ? 'Account lookup failed — check API access'
            : 'No related Account found');
        }
        if (!appData || !appData.contactId) {
          markDisabled(contactBtn, appData && appData.error
            ? 'Contact lookup failed — check API access'
            : 'No related Contact found');
        }
        if (!appData || !appData.partyId) {
          markDisabled(partyBtn, 'No related Party found');
        }

        if (appData && appData.error) {
          dot.classList.add('sfn-status-dot--error');
          dot.title = 'API error — some records could not be loaded';
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

    // For Classic record pages with unknown prefix, try UI API resolution
    if (page && page.isRecordPage && page.recordId && !page.objectType) {
      page.objectType = await resolveObjectType(page.recordId);
    }

    const isApp = page && page.objectType === APP_OBJECT;

    if (isApp) {
      // Show toolbar immediately with loading spinners
      document.body.appendChild(buildToolbar(page, null, true));

      // Fetch related data asynchronously
      const appData = await fetchAppData(page.recordId);

      // Swap in the final toolbar
      const old = document.getElementById(TOOLBAR_ID);
      if (old) old.remove();
      document.body.appendChild(buildToolbar(page, appData, false));
    } else {
      document.body.appendChild(buildToolbar(page, null, false));
    }
  }

  // ─── SPA / Lightning navigation support ──────────────────────────────────

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