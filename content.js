/**
 * SF Navigator – Content Script
 * Premium Salesforce navigation toolbar.
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  const APP_OBJECT = 'genesis__Applications__c';
  const TOOLBAR_ID = 'sf-navigator-root';

  // ─── Salesforce URL helpers ───────────────────────────────────────────────

  /**
   * Return the base URL suitable for Classic navigation.
   * On Lightning (*.lightning.force.com) rewrite to *.my.salesforce.com so
   * Classic links work correctly in both production and sandbox orgs.
   *
   * Examples:
   *   myorg.lightning.force.com        → myorg.my.salesforce.com
   *   myorg--uat.sandbox.my.salesforce.com  → unchanged (already classic-compatible)
   *   myorg.my.salesforce.com          → unchanged
   *   cs123.salesforce.com             → unchanged
   */
  function getClassicBaseUrl() {
    const { protocol, hostname } = window.location;
    // Rewrite Lightning domain → My Domain (works for prod & sandbox)
    const classicHost = hostname.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    return `${protocol}//${classicHost}`;
  }

  /** Return the base URL as-is (used for API calls – must stay on current host). */
  function getBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  /**
   * Known Visualforce page names that correspond to a specific SObject.
   * Key = page name (case-insensitive), value = SObject API name.
   */
  const VF_PAGE_OBJECT_MAP = {
    'applicationdetails':  'genesis__Applications__c',
    'application_details': 'genesis__Applications__c',
    'applicationdetail':   'genesis__Applications__c',
  };

  /**
   * Parse the current page URL and return record info or null.
   *
   * Supported patterns:
   *  1. Lightning  /lightning/r/ObjectApiName/RecordId/view
   *  2. Classic    /RecordId   (15 or 18 char ID in path)
   *  3. VF / Apex  /apex/PageName?id=RecordId   ← NEW
   *  4. Classic    ?id=RecordId  (generic query-param fallback)
   */
  function parseCurrentRecord() {
    const { pathname, searchParams } = new URL(window.location.href);

    // 1. Lightning URL: /lightning/r/ObjectApiName/RecordId/view
    const lightningMatch = pathname.match(
      /\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\//
    );
    if (lightningMatch) {
      return { objectType: lightningMatch[1], recordId: lightningMatch[2], isLightning: true };
    }

    // 2. Classic path: /RecordId
    const classicPathMatch = pathname.match(/^\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (classicPathMatch) {
      return { objectType: null, recordId: classicPathMatch[1], isLightning: false };
    }

    // 3. Apex / Visualforce page: /apex/PageName?id=RecordId
    const apexMatch = pathname.match(/\/apex\/([^/?#]+)/i);
    const idParam = searchParams.get('id');
    if (apexMatch && idParam && /^[a-zA-Z0-9]{15,18}$/.test(idParam)) {
      const pageName = apexMatch[1].toLowerCase();
      const objectType = VF_PAGE_OBJECT_MAP[pageName] || null;
      return { objectType, recordId: idParam, isLightning: false };
    }

    // 4. Generic query-param fallback: ?id=RecordId
    if (idParam && /^[a-zA-Z0-9]{15,18}$/.test(idParam)) {
      return { objectType: null, recordId: idParam, isLightning: false };
    }

    return null;
  }

  /**
   * Derive Salesforce object type from a 15/18-char record ID prefix.
   */
  const KEY_PREFIX_MAP = {
    '001': 'Account',
    '003': 'Contact',
    '006': 'Opportunity',
    '500': 'Case',
  };

  function objectTypeFromId(id) {
    if (!id) return null;
    return KEY_PREFIX_MAP[id.substring(0, 3)] || null;
  }

  // ─── REST API helper ──────────────────────────────────────────────────────

  function sfRestQuery(query) {
    const base = getBaseUrl();
    const endpoint = `${base}/services/data/v59.0/query?q=${encodeURIComponent(query)}`;
    return fetch(endpoint, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  }

  // ─── URL builders ─────────────────────────────────────────────────────────

  function classicUrl(id) {
    // Always use the Classic-compatible base URL (handles sandbox rewrites)
    return `${getClassicBaseUrl()}/${id}?nooverride=1`;
  }

  function lightningUrl(objectType, id) {
    return `${getBaseUrl()}/lightning/r/${objectType}/${id}/view`;
  }

  function noOverrideUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('nooverride', '1');
    return url.toString();
  }

  // ─── SVG Icons ────────────────────────────────────────────────────────────

  const ICONS = {
    classic: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    lightning: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    nooverride: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    account: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    contact: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    party: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    openall: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    logo: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
  };

  // ─── DOM builder ─────────────────────────────────────────────────────────

  function makeButton({ id, icon, label, tooltip, variant, onClick }) {
    const btn = document.createElement('button');
    btn.id = `sfn-btn-${id}`;
    btn.className = `sfn-btn sfn-btn--${variant}`;
    btn.setAttribute('data-tooltip', tooltip);
    btn.innerHTML = `<span class="sfn-btn-icon">${icon}</span><span class="sfn-btn-label">${label}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setLoading(btn, loading) {
    if (loading) {
      btn.classList.add('sfn-loading');
      btn.querySelector('.sfn-btn-icon').innerHTML = ICONS.spinner;
    } else {
      btn.classList.remove('sfn-loading');
    }
  }

  // ─── Core toolbar builder ─────────────────────────────────────────────────

  function buildToolbar(record, appData) {
    const isApp = record.objectType === APP_OBJECT;
    const baseUrl = getBaseUrl();

    // Wrapper (positioning root)
    const root = document.createElement('div');
    root.id = TOOLBAR_ID;

    const toolbar = document.createElement('div');
    toolbar.id = 'sf-navigator-toolbar';

    // Logo
    const logo = document.createElement('div');
    logo.className = 'sfn-logo';
    logo.innerHTML = `
      <div class="sfn-logo-icon">${ICONS.logo}</div>
      <span class="sfn-logo-text">SF Nav</span>
    `;
    toolbar.appendChild(logo);

    // ── Classic button ──────────────────────────────────────────────────────
    const classicBtn = makeButton({
      id: 'classic',
      icon: ICONS.classic,
      label: 'Classic',
      tooltip: 'Open in Salesforce Classic',
      variant: 'classic',
      onClick: () => {
        window.open(classicUrl(record.recordId), '_blank');
      },
    });
    toolbar.appendChild(classicBtn);

    // ── Lightning button ────────────────────────────────────────────────────
    const lightningBtn = makeButton({
      id: 'lightning',
      icon: ICONS.lightning,
      label: 'Lightning',
      tooltip: 'Open in Lightning Experience',
      variant: 'lightning',
      onClick: () => {
        const objType = record.objectType || objectTypeFromId(record.recordId);
        if (objType) {
          window.open(lightningUrl(objType, record.recordId), '_blank');
        } else {
          window.open(`${baseUrl}/one/one.app#/sObject/${record.recordId}/view`, '_blank');
        }
      },
    });
    toolbar.appendChild(lightningBtn);

    // ── App-specific buttons ────────────────────────────────────────────────
    if (isApp) {
      toolbar.appendChild(createDivider());

      // No Override
      const noOvrBtn = makeButton({
        id: 'nooverride',
        icon: ICONS.nooverride,
        label: 'No Override',
        tooltip: 'Open Application with ?nooverride=1',
        variant: 'nooverride',
        onClick: () => {
          window.open(noOverrideUrl(), '_blank');
        },
      });
      toolbar.appendChild(noOvrBtn);

      // Account
      const accountBtn = makeButton({
        id: 'account',
        icon: ICONS.account,
        label: 'Account',
        tooltip: 'Open related Account (Classic)',
        variant: 'account',
        onClick: () => {
          if (appData.accountId) {
            window.open(classicUrl(appData.accountId), '_blank');
          }
        },
      });
      if (!appData.accountId) accountBtn.disabled = true;
      toolbar.appendChild(accountBtn);

      // Contact
      const contactBtn = makeButton({
        id: 'contact',
        icon: ICONS.contact,
        label: 'Contact',
        tooltip: 'Open related Contact (Classic)',
        variant: 'contact',
        onClick: () => {
          if (appData.contactId) {
            window.open(classicUrl(appData.contactId), '_blank');
          }
        },
      });
      if (!appData.contactId) contactBtn.disabled = true;
      toolbar.appendChild(contactBtn);

      // Party
      const partyBtn = makeButton({
        id: 'party',
        icon: ICONS.party,
        label: 'Party',
        tooltip: 'Open related Party (Classic)',
        variant: 'party',
        onClick: () => {
          if (appData.partyId) {
            window.open(classicUrl(appData.partyId), '_blank');
          }
        },
      });
      if (!appData.partyId) partyBtn.disabled = true;
      toolbar.appendChild(partyBtn);

      toolbar.appendChild(createDivider());

      // Open All
      const openAllBtn = makeButton({
        id: 'openall',
        icon: ICONS.openall,
        label: 'Open All',
        tooltip: 'Open No Override, Account, Contact & Party',
        variant: 'openall',
        onClick: () => {
          window.open(noOverrideUrl(), '_blank');
          if (appData.accountId) window.open(classicUrl(appData.accountId), '_blank');
          if (appData.contactId) window.open(classicUrl(appData.contactId), '_blank');
          if (appData.partyId)   window.open(classicUrl(appData.partyId), '_blank');
        },
      });
      toolbar.appendChild(openAllBtn);
    }

    root.appendChild(toolbar);
    return root;
  }

  function createDivider() {
    const d = document.createElement('div');
    d.className = 'sfn-divider';
    return d;
  }

  // ─── Object type resolver ─────────────────────────────────────────────────

  /**
   * For Lightning pages the object type is in the URL.
   * For Classic pages we need to call the REST API to get the object type.
   */
  async function resolveObjectType(recordId) {
    try {
      const base = getBaseUrl();
      const url = `${base}/services/data/v59.0/sobjects/`;
      // Fastest path: use the SObject describe by record ID
      const resp = await fetch(
        `${base}/services/data/v59.0/ui-api/records/${recordId}?fields=Id`,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.apiName || null;
    } catch {
      return null;
    }
  }

  // ─── Application data fetcher ─────────────────────────────────────────────

  async function fetchAppData(appId) {
    const appData = { accountId: null, contactId: null, partyId: null };

    try {
      // Account + Contact
      const acQuery = `SELECT genesis__Account__c, genesis__Contact__c FROM genesis__Applications__c WHERE Id = '${appId}'`;
      const acResult = await sfRestQuery(acQuery);
      if (acResult.records && acResult.records.length > 0) {
        appData.accountId = acResult.records[0].genesis__Account__c || null;
        appData.contactId = acResult.records[0].genesis__Contact__c || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Account/Contact query failed:', e);
    }

    try {
      // Party
      const partyQuery = `SELECT Id FROM clcommon__Party__c WHERE genesis__Application__c = '${appId}' LIMIT 1`;
      const partyResult = await sfRestQuery(partyQuery);
      if (partyResult.records && partyResult.records.length > 0) {
        appData.partyId = partyResult.records[0].Id || null;
      }
    } catch (e) {
      console.warn('[SF Navigator] Party query failed:', e);
    }

    return appData;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    // Don't inject twice
    if (document.getElementById(TOOLBAR_ID)) return;

    const record = parseCurrentRecord();
    if (!record) return; // Not a record page

    // Resolve object type for Classic pages
    if (!record.objectType) {
      record.objectType = objectTypeFromId(record.recordId)
        || await resolveObjectType(record.recordId);
    }

    const isApp = record.objectType === APP_OBJECT;

    // Build toolbar immediately with basic buttons; load app data async
    let appData = { accountId: null, contactId: null, partyId: null };

    if (isApp) {
      // Show toolbar with loading state first
      const tempRoot = buildToolbar(record, appData);
      document.body.appendChild(tempRoot);

      // Fetch app data, then rebuild
      appData = await fetchAppData(record.recordId);
      document.body.removeChild(tempRoot);
    }

    const root = buildToolbar(record, appData);
    document.body.appendChild(root);
  }

  // ─── SPA navigation support ───────────────────────────────────────────────
  // Lightning is a SPA; watch for URL changes.

  let lastUrl = location.href;

  function onUrlChange() {
    const current = location.href;
    if (current === lastUrl) return;
    lastUrl = current;

    // Remove old toolbar
    const existing = document.getElementById(TOOLBAR_ID);
    if (existing) existing.remove();

    // Short delay to let Lightning update the DOM
    setTimeout(init, 400);
  }

  // Override pushState / replaceState to catch Lightning navigation
  ['pushState', 'replaceState'].forEach((method) => {
    const original = history[method];
    history[method] = function (...args) {
      original.apply(this, args);
      onUrlChange();
    };
  });

  window.addEventListener('popstate', onUrlChange);

  // Initial run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();