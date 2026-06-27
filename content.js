/**
 * SF Navigator v2 — Content Script
 *
 * Premium Salesforce navigation toolbar.
 * Works on ANY Salesforce page — record pages, list views, home, setup, etc.
 *
 * Architecture:
 *  - API calls are proxied through background.js (fixes CSP / cookie auth issues)
 *  - URL detection covers Lightning, Classic, Apex/VF, and generic SF pages
 *  - Classic ↔ Lightning switching works on every page, not just records
 */

(function () {
  'use strict';

  // ─── Guard: don't run on login / setup-domain pages ─────────────────────

  const EXCLUDED_PATHS = [
    /^\/login/i,
    /^\/secur\/login/i,
    /^\/services\//i,
    /^\/oauth2\//i,
  ];

  if (EXCLUDED_PATHS.some((re) => re.test(window.location.pathname))) return;

  // ─── Constants ───────────────────────────────────────────────────────────

  const APP_OBJECT   = 'genesis__Applications__c';
  const TOOLBAR_ID   = 'sf-navigator-root';
  const SF_ID_REGEX  = /^[a-zA-Z0-9]{15,18}$/;
  const SF_API_VER   = 'v59.0';

  // ─── Object key-prefix map (Classic record IDs) ──────────────────────────

  const KEY_PREFIX_MAP = {
    '001': 'Account',
    '003': 'Contact',
    '006': 'Opportunity',
    '00Q': 'Lead',
    '500': 'Case',
    '00T': 'Task',
    '00U': 'Event',
    '01Z': 'Report',
  };

  // ─── Known Visualforce page names → SObject type ─────────────────────────

  const VF_PAGE_OBJECT_MAP = {
    'applicationdetails':  APP_OBJECT,
    'application_details': APP_OBJECT,
    'applicationdetail':   APP_OBJECT,
    'genesisapplication':  APP_OBJECT,
  };

  // ─── URL Helpers ──────────────────────────────────────────────────────────

  /**
   * Returns the base URL appropriate for Classic navigation.
   * On lightning.force.com domains, rewrites to my.salesforce.com so that
   * Classic links work correctly in both production and sandbox orgs.
   *
   * Examples:
   *   myorg.lightning.force.com          → myorg.my.salesforce.com
   *   myorg--uat.sandbox.my.salesforce.com → unchanged
   *   myorg.my.salesforce.com            → unchanged
   */
  function getClassicBaseUrl() {
    const { protocol, hostname } = window.location;
    const classicHost = hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    return `${protocol}//${classicHost}`;
  }

  /** Current-origin base URL — used for API calls (must stay on current host). */
  function getApiBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  /**
   * Returns the lightning.force.com base URL.
   * Works from classic (my.salesforce.com) or from lightning domain itself.
   */
  function getLightningBaseUrl() {
    const { protocol, hostname } = window.location;
    // Already on lightning domain
    if (hostname.includes('.lightning.force.com')) {
      return `${protocol}//${hostname}`;
    }
    // Rewrite my.salesforce.com → lightning.force.com
    // myorg.my.salesforce.com              → myorg.lightning.force.com
    // myorg--uat.sandbox.my.salesforce.com → myorg--uat.sandbox.my.salesforce.com (no direct mapping)
    // For sandboxes that use the my.salesforce.com domain, the lightning equivalent
    // is typically accessed at the same domain but through the LEX router
    const lightningHost = hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    if (lightningHost !== hostname) {
      return `${protocol}//${lightningHost}`;
    }
    // Sandbox: hostname stays the same; we'll use the /ltng/switcher approach
    return `${protocol}//${hostname}`;
  }

  /** True if we're currently on a Lightning Experience domain. */
  function isLightningDomain() {
    return window.location.hostname.includes('.lightning.force.com');
  }

  /** True if we're currently on a Lightning Experience page (URL path). */
  function isLightningPage() {
    return isLightningDomain() || window.location.pathname.startsWith('/lightning/');
  }

  // ─── Page / Record detection ──────────────────────────────────────────────

  /**
   * Derive Salesforce object type from a record ID prefix.
   * Returns null if prefix is unknown.
   */
  function objectTypeFromId(id) {
    if (!id || id.length < 3) return null;
    return KEY_PREFIX_MAP[id.substring(0, 3)] || null;
  }

  /**
   * Parse the current page URL.
   * Returns:
   *   { objectType, recordId, isLightning, isRecordPage }
   * or null if this is not a recognisable Salesforce page with a record.
   *
   * For non-record pages, returns:
   *   { objectType: null, recordId: null, isLightning, isRecordPage: false }
   */
  function parseCurrentPage() {
    const { pathname, searchParams } = new URL(window.location.href);
    const onLightning = isLightningPage();

    // 1. Lightning record URL: /lightning/r/ObjectApiName/RecordId/view
    const lightningMatch = pathname.match(
      /\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//
    );
    if (lightningMatch) {
      return {
        objectType:   lightningMatch[1],
        recordId:     lightningMatch[2],
        isLightning:  true,
        isRecordPage: true,
      };
    }

    // 2. Classic path: /{RecordId} or /{RecordId}/e etc.
    const classicPathMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicPathMatch) {
      const id = classicPathMatch[1];
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
    if (apexMatch && idParam && SF_ID_REGEX.test(idParam)) {
      const pageName   = apexMatch[1].toLowerCase();
      const objectType = VF_PAGE_OBJECT_MAP[pageName] || null;
      return {
        objectType,
        recordId:     idParam,
        isLightning:  false,
        isRecordPage: true,
      };
    }

    // 4. Generic ?id=RecordId fallback
    if (idParam && SF_ID_REGEX.test(idParam)) {
      return {
        objectType:   objectTypeFromId(idParam),
        recordId:     idParam,
        isLightning:  onLightning,
        isRecordPage: true,
      };
    }

    // 5. Not a record page — still show Classic/Lightning switch buttons
    return {
      objectType:   null,
      recordId:     null,
      isLightning:  onLightning,
      isRecordPage: false,
    };
  }

  // ─── URL builders ─────────────────────────────────────────────────────────

  /** Classic URL for any record (handles sandbox domain rewriting). */
  function classicRecordUrl(id) {
    return `${getClassicBaseUrl()}/${id}?nooverride=1`;
  }

  /** Lightning URL for a known record + object type. */
  function lightningRecordUrl(objectType, id) {
    return `${getLightningBaseUrl()}/lightning/r/${objectType}/${id}/view`;
  }

  /**
   * No Override URL: current page with ?nooverride=1, stripping any
   * sfdc.override or conflicting override params.
   */
  function noOverrideUrl() {
    const url = new URL(window.location.href);
    // Remove conflicting override params
    url.searchParams.delete('sfdc.override');
    url.searchParams.delete('sfdc_override');
    // Set nooverride
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  /**
   * Build the "Switch to Classic" URL for ANY current page.
   *  - If on a Lightning record page → open that record on Classic domain
   *  - If on any other Lightning page → use /ltng/switcher?destination=classic
   *  - If already Classic → still ensure nooverride is respected
   */
  function switchToClassicUrl(page) {
    if (page && page.isRecordPage && page.recordId) {
      return classicRecordUrl(page.recordId);
    }

    // Non-record Lightning page — use switcher endpoint or domain rewrite
    const classicBase = getClassicBaseUrl();

    if (isLightningDomain()) {
      // Use Salesforce's own switcher for non-record Lightning pages
      const retUrl = encodeURIComponent(window.location.href);
      return `${classicBase}/ltng/switcher?destination=classic&referrer=${retUrl}`;
    }

    // Already on Classic domain — rebuild with nooverride
    return noOverrideUrl();
  }

  /**
   * Build the "Switch to Lightning" URL for ANY current page.
   *  - If on a Classic record page with known object type → /lightning/r/...
   *  - If on any other Classic page → /ltng/switcher?destination=lex
   *  - If already Lightning → rebuild URL on lightning domain
   */
  function switchToLightningUrl(page) {
    const lightningBase = getLightningBaseUrl();

    if (page && page.isRecordPage && page.recordId) {
      if (page.objectType) {
        return lightningRecordUrl(page.objectType, page.recordId);
      }
      // Unknown object type on Classic — fall back to one.app sObject view
      return `${lightningBase}/one/one.app#/sObject/${page.recordId}/view`;
    }

    // Non-record page — use the Salesforce switcher
    if (!isLightningDomain()) {
      const retUrl = encodeURIComponent(window.location.href);
      return `${lightningBase}/ltng/switcher?destination=lex&referrer=${retUrl}`;
    }

    // Already on Lightning — rebuild with lightning base
    const url = new URL(window.location.href);
    url.hostname = url.hostname.replace('.my.salesforce.com', '.lightning.force.com');
    return url.toString();
  }

  // ─── Background API bridge ────────────────────────────────────────────────

  function bgQuery(query) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfQuery', baseUrl: getApiBaseUrl(), query },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.ok) {
            resolve(response.data);
          } else {
            reject(new Error((response && response.error) || 'Unknown error'));
          }
        }
      );
    });
  }

  function bgFetch(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'sfFetch', url },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.ok) {
            resolve(response.data);
          } else {
            reject(new Error((response && response.error) || 'Unknown error'));
          }
        }
      );
    });
  }

  // ─── Object type resolver (for Classic record pages) ──────────────────────

  /**
   * Call Salesforce UI API to get the object type for a record ID.
   * This is used when we're on a Classic page and don't know the object type.
   */
  async function resolveObjectType(recordId) {
    try {
      const url = `${getApiBaseUrl()}/services/data/${SF_API_VER}/ui-api/records/${recordId}?fields=Id`;
      const data = await bgFetch(url);
      return (data && data.apiName) || null;
    } catch {
      return null;
    }
  }

  // ─── Application data fetcher ─────────────────────────────────────────────

  /**
   * Fetch Account, Contact and Party IDs for a genesis__Applications__c record.
   * Returns { accountId, contactId, partyId, error }.
   */
  async function fetchAppData(appId) {
    const result = { accountId: null, contactId: null, partyId: null, error: false };

    try {
      const acQuery = `SELECT genesis__Account__c, genesis__Contact__c FROM genesis__Applications__c WHERE Id = '${appId}'`;
      const acData = await bgQuery(acQuery);
      if (acData && acData.records && acData.records.length > 0) {
        result.accountId = acData.records[0].genesis__Account__c || null;
        result.contactId = acData.records[0].genesis__Contact__c || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Account/Contact query failed:', e.message);
      result.error = true;
    }

    try {
      const partyQuery = `SELECT Id FROM clcommon__Party__c WHERE genesis__Application__c = '${appId}' LIMIT 1`;
      const partyData = await bgQuery(partyQuery);
      if (partyData && partyData.records && partyData.records.length > 0) {
        result.partyId = partyData.records[0].Id || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Party query failed:', e.message);
      // Don't mark overall error for party — it's a secondary lookup
    }

    return result;
  }

  // ─── SVG Icons ────────────────────────────────────────────────────────────

  const ICONS = {
    classic: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    lightning: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    nooverride: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    account: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    contact: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    party: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    openall: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    logo: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
    warning: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };

  // ─── DOM Utilities ────────────────────────────────────────────────────────

  /**
   * Create a toolbar button.
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.icon  — SVG string
   * @param {string} opts.label
   * @param {string} opts.tooltip
   * @param {string} opts.variant — CSS variant suffix (e.g. 'classic')
   * @param {boolean} [opts.active] — Whether to show active/current-view state
   * @param {function} opts.onClick
   */
  function makeButton({ id, icon, label, tooltip, variant, active, onClick }) {
    const btn = document.createElement('button');
    btn.id = `sfn-btn-${id}`;
    btn.className = `sfn-btn sfn-btn--${variant}${active ? ' sfn-btn--active' : ''}`;
    btn.setAttribute('data-tooltip', tooltip);
    btn.innerHTML = `<span class="sfn-btn-icon">${icon}</span><span class="sfn-btn-label">${label}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setLoading(btn, isLoading, originalIcon) {
    if (isLoading) {
      btn.classList.add('sfn-loading');
      btn.querySelector('.sfn-btn-icon').innerHTML = ICONS.spinner;
    } else {
      btn.classList.remove('sfn-loading');
      if (originalIcon) btn.querySelector('.sfn-btn-icon').innerHTML = originalIcon;
    }
  }

  function setDisabled(btn, isDisabled, tooltipOverride) {
    btn.disabled = isDisabled;
    if (tooltipOverride) btn.setAttribute('data-tooltip', tooltipOverride);
    if (isDisabled) btn.classList.add('sfn-btn--disabled');
    else btn.classList.remove('sfn-btn--disabled');
  }

  function createDivider() {
    const d = document.createElement('div');
    d.className = 'sfn-divider';
    return d;
  }

  // ─── Toolbar Builder ──────────────────────────────────────────────────────

  /**
   * Build and inject the toolbar.
   * @param {object} page  — from parseCurrentPage()
   * @param {object|null} appData — from fetchAppData() (only if isApp)
   * @param {boolean} isLoading  — show loading state on app buttons
   */
  function buildToolbar(page, appData, isLoading) {
    const isApp    = page && page.objectType === APP_OBJECT;
    const onLEX    = page ? page.isLightning : isLightningPage();

    const root = document.createElement('div');
    root.id = TOOLBAR_ID;

    const toolbar = document.createElement('div');
    toolbar.id = 'sf-navigator-toolbar';

    // ── Logo ────────────────────────────────────────────────────────────────
    const logo = document.createElement('div');
    logo.className = 'sfn-logo';
    logo.innerHTML = `
      <div class="sfn-logo-icon">${ICONS.logo}</div>
      <span class="sfn-logo-text">SF Nav</span>
    `;
    toolbar.appendChild(logo);

    // ── Classic button ───────────────────────────────────────────────────────
    const classicBtn = makeButton({
      id:      'classic',
      icon:    ICONS.classic,
      label:   'Classic',
      tooltip: onLEX ? 'Switch to Salesforce Classic' : 'Reload in Classic view',
      variant: 'classic',
      active:  !onLEX,
      onClick: () => { window.open(switchToClassicUrl(page), '_blank'); },
    });
    toolbar.appendChild(classicBtn);

    // ── Lightning button ─────────────────────────────────────────────────────
    const lightningBtn = makeButton({
      id:      'lightning',
      icon:    ICONS.lightning,
      label:   'Lightning',
      tooltip: !onLEX ? 'Switch to Lightning Experience' : 'Reload in Lightning view',
      variant: 'lightning',
      active:  onLEX,
      onClick: () => { window.open(switchToLightningUrl(page), '_blank'); },
    });
    toolbar.appendChild(lightningBtn);

    // ── App-specific section (genesis__Applications__c only) ─────────────────
    if (isApp) {
      toolbar.appendChild(createDivider());

      // No Override
      const noOvrBtn = makeButton({
        id:      'nooverride',
        icon:    ICONS.nooverride,
        label:   'No Override',
        tooltip: 'Open Application with ?nooverride=1 (strips Visualforce override)',
        variant: 'nooverride',
        onClick: () => { window.open(noOverrideUrl(), '_blank'); },
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
          if (appData && appData.accountId) {
            window.open(classicRecordUrl(appData.accountId), '_blank');
          }
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
          if (appData && appData.contactId) {
            window.open(classicRecordUrl(appData.contactId), '_blank');
          }
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
          if (appData && appData.partyId) {
            window.open(classicRecordUrl(appData.partyId), '_blank');
          }
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

      // ── Status dot (shows data-load state) ──────────────────────────────
      const statusDot = document.createElement('div');
      statusDot.id = 'sfn-status-dot';
      statusDot.className = 'sfn-status-dot' + (isLoading ? ' sfn-status-dot--loading' : '');
      statusDot.title = isLoading ? 'Loading related records…' : 'Related records loaded';
      toolbar.appendChild(statusDot);

      // Apply loading / disabled states after data is known
      if (isLoading) {
        [accountBtn, contactBtn, partyBtn, openAllBtn].forEach((b) => {
          setLoading(b, true, null);
        });
      } else {
        // Account
        if (!appData || !appData.accountId) {
          setDisabled(accountBtn, true,
            appData && appData.error
              ? 'Account lookup failed (API error)'
              : 'No related Account found'
          );
        }
        // Contact
        if (!appData || !appData.contactId) {
          setDisabled(contactBtn, true,
            appData && appData.error
              ? 'Contact lookup failed (API error)'
              : 'No related Contact found'
          );
        }
        // Party
        if (!appData || !appData.partyId) {
          setDisabled(partyBtn, true, 'No related Party found');
        }

        // Status dot color
        if (appData && appData.error) {
          statusDot.classList.add('sfn-status-dot--error');
          statusDot.title = 'Some related records failed to load';
        }
      }
    }

    root.appendChild(toolbar);
    return root;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    // Don't inject twice
    if (document.getElementById(TOOLBAR_ID)) return;

    const page = parseCurrentPage();

    // For Classic record pages: try to resolve the object type
    if (page && page.isRecordPage && page.recordId && !page.objectType) {
      page.objectType = await resolveObjectType(page.recordId);
    }

    const isApp = page && page.objectType === APP_OBJECT;

    if (isApp) {
      // Inject immediately with loading spinners on app buttons
      const loadingRoot = buildToolbar(page, null, true);
      document.body.appendChild(loadingRoot);

      // Fetch app data asynchronously
      const appData = await fetchAppData(page.recordId);

      // Remove loading toolbar and inject final one
      const existing = document.getElementById(TOOLBAR_ID);
      if (existing) existing.remove();

      const finalRoot = buildToolbar(page, appData, false);
      document.body.appendChild(finalRoot);
    } else {
      // No async data needed — inject directly
      const root = buildToolbar(page, null, false);
      document.body.appendChild(root);
    }
  }

  // ─── SPA navigation (Lightning is a SPA) ─────────────────────────────────

  let lastUrl = location.href;

  function onUrlChange() {
    const current = location.href;
    if (current === lastUrl) return;
    lastUrl = current;

    const existing = document.getElementById(TOOLBAR_ID);
    if (existing) existing.remove();

    // Small delay to let Lightning update the DOM/URL fully
    setTimeout(init, 450);
  }

  // Intercept pushState / replaceState for Lightning SPA routing
  ['pushState', 'replaceState'].forEach((method) => {
    const original = history[method];
    history[method] = function (...args) {
      original.apply(this, args);
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