# SF Pilot — Project Requirements & Details

## What We're Building

**SF Pilot** is a premium, high-performance Chrome Extension (Manifest V3) designed for Salesforce administrators, developers, and power users. It combines a floating context-aware record navigation toolbar with an always-accessible **Developer Command Palette** to drastically accelerate daily Salesforce navigation and metadata management.

The extension is built strictly using **vanilla HTML, CSS, and JavaScript** to guarantee zero performance overhead, zero dependencies, and instant execution.

---

## 1. Technology Constraints

* **Pure Vanilla Only:** Standard HTML5, CSS3, and ES6+ JavaScript. No frameworks (React/Vue), no TypeScript, no build tools (Webpack/Vite), and no CSS frameworks (Tailwind/Bootstrap).
* **Manifest Version:** Chrome Extension Manifest V3.
* **Lightweight Footprint:** Memory footprint is kept minimal. Metadata queries are lazy-loaded, run in parallel in the background worker, and cached in-memory.

---

## 2. Floating Context Record Toolbar

Injected at the **top center** of active Salesforce record pages using a premium frosted-glass (glassmorphism) layout.

### Scope & Visibility
* Appears **only** on active Salesforce record pages (standard and custom objects).
* Ignored on homepages, list views, setup menus, and metadata configurations.
* **SPA Transition Lock:** Employs an `isNavigating` flag during Lightning Single Page App (SPA) transitions, silencing DOM MutationObservers to prevent race conditions or infinite injection loops. This guarantees reliable rendering with **zero page reloads required**.

### Visibility & Actions Table

| Page Type | Active Buttons | Navigation Behavior |
| :--- | :--- | :--- |
| **Any Record Page** | Classic, Lightning | Opens the current record in Classic or Lightning (new tab). Fades out and disables the button corresponding to the active view. |
| **`genesis__Applications__c` Record** | Classic, Lightning, No Override, Account, Contact, Party, Open All | Fetches related Account, Contact, and Party IDs using REST API queries in the background and enables quick links. Account, Contact, and Party always open in Classic. |

---

## 3. Developer Command Palette (Side Pilot Search)

An always-visible search button `(#sfp-side-btn)` floats on the middle-right edge of **every Salesforce page** (including Setup, List Views, and standard layouts). 

### Activation
* **Clicking** the side wing button.
* Pressing the global keyboard shortcuts:
  * **`Ctrl + Space`** (Windows / Linux)
  * **`Cmd + Space`** (macOS)

### Scope of Autocomplete Search
Queries and maps multiple Salesforce metadata directories in parallel via the background script:

1. **Objects:** Standard and Custom sObjects.
2. **Apex Classes:** All Apex Code files (`ApexClass`).
3. **Apex Triggers:** Event triggers (`ApexTrigger`).
4. **Visualforce Pages:** VF markup templates (`ApexPage`).
5. **Custom Labels:** All localization variables (`ExternalString` queried via Tooling API).
6. **Custom Settings:** Custom setting objects (queried via `EntityDefinition` where `IsCustomSetting = true`). Deduplicated from the default sObjects list automatically.

### High-Contrast Color Tags
Every autocomplete result has a labeled pill tag identifying its metadata type:
* **`OBJECT`** (Green) — Standard/Custom sObjects.
* **`CLASS`** (Purple) — Apex Classes.
* **`TRIGGER`** (Orange) — Apex Triggers.
* **`PAGE`** (Blue) — Visualforce Pages.
* **`LABEL`** (Gold) — Custom Labels.
* **`SETTING`** (Teal) — Custom Settings.

### Setup Redirection Logic (Salesforce Classic)
Selecting a metadata element routes you directly to its admin Setup screen in Classic:
* **Standard Objects / Settings:** Opens the Fields List Setup page.
* **Custom Objects:** Opens the Custom Object definition screen. Maps using the **15-character Classic Setup ID** formatted as `/{15_char_id}?setupid=CustomObjects` to prevent access or URL errors.
* **Apex / Visualforce / Custom Labels:** Opens the code editor or detail Setup panel using their unique Salesforce ID directly.

---

## 4. Performance & Resilience Design

* **Zero Page-Load Impact:** No Salesforce APIs are queried on page load. All metadata indexing is lazy-loaded (triggered only when the search panel is opened for the first time).
* **Parallel API Requests:** Background metadata compilation queries are run concurrently, reducing load latency.
* **CORS-Free background Service Worker:** Requests bypass browser preflights using background host permissions.
* **Query Timeout Guard:** A **2.0-second AbortController timeout** is attached to Tooling queries. If the Tooling API is slow or blocked, it aborts cleanly, and the search suggestions still load instantly with the remaining categories.
* **Rendering Optimization:** Search results are sliced to the top 60 matches (`.slice(0, 60)`). This limits DOM rendering load and prevents typing lag.

---

## 5. Security & Authentication

* **Session Authorization:** Rides on the browser's active, authenticated session (`credentials: 'include'`). The extension does not store, request, or transmit user credentials.
* **Sid Cookie Extraction:** The background script reads the `sid` cookie valid for the Classic domain (`*.my.salesforce.com` or `*.sandbox.my.salesforce.com`), which acts as the OAuth Bearer token for REST requests.
* **Non-Org Domain Guard:** Explicitly exits and remains disabled on public-facing Salesforce portals (e.g. Trailhead, AppExchange, Help, Trust, success, and login pages) to prevent shortcut capture.

---

## 6. Sandbox & Scratch Org Support

Matches and permissions are configured to support multi-subdomain sandbox and developer scratch org environments recursive structures:
* `https://*.sandbox.lightning.force.com/*`
* `https://*.sandbox.my.salesforce.com/*`
* `https://*.develop.lightning.force.com/*`
* `https://*.develop.my.salesforce.com/*`

Domain normalizers in `background.js` and `content.js` automatically map sandboxes to their Classic Sandbox subdomains (`.sandbox.my.salesforce.com` / `.develop.my.salesforce.com`) to extract the appropriate session cookies.

---

## 7. Developer Branding Credit

* Description in `manifest.json`: *"Premium Salesforce navigation toolbar. Made with ❤️ by Abhishek Jaiswal."*
* Search modal footer includes a micro-animated beating red heart and an electric-blue hover glow on the author's name, which opens their LinkedIn profile (`https://www.linkedin.com/in/theabhishekjaiswal12/`) in a new tab when clicked.
* Record toolbar logo includes a hover title credit: *"SF Pilot — Made with ❤️ by Abhishek Jaiswal"*.