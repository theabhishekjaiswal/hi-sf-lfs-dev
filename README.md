# SF Pilot 🚀

**SF Pilot** is a premium, high-performance Chrome Extension (Manifest V3) designed for Salesforce administrators, developers, and power users. It combines a floating context-aware record navigation toolbar with an always-accessible **Developer Command Palette** to drastically accelerate daily Salesforce navigation and metadata management.

Built strictly using **vanilla HTML, CSS, and JavaScript**, it guarantees zero performance overhead, zero dependencies, and instant execution.

---

## Key Features

### 1. Floating Context Record Toolbar
Injected at the **top center** of active Salesforce record pages using a premium frosted-glass (glassmorphism) layout.
* **Smart Page Detection:** Appears automatically on record detail pages (standard and custom objects), and hides itself on list views, homepages, and setup.
* **SPA Transition Lock:** Employs an `isNavigating` flag during Lightning Single Page App (SPA) transitions, silencing DOM MutationObservers to prevent race conditions or infinite injection loops. This guarantees reliable rendering with **zero page reloads required**.
* **Navigation Quick Links:**
  * **Classic / Lightning Toggle:** Instantly open the current record in Classic or Lightning in a new tab.
  * **Application Record Upgrades:** For `genesis__Applications__c` record pages, it automatically fetches related Account, Contact, and Party IDs via REST API queries in the background and enables quick links to open them directly.
  * **No Override & Open All:** Open application records bypassing Visualforce overrides, or open all related records in one click.

### 2. Developer Command Palette (Side Pilot Search)
An always-visible search button floats on the middle-right edge of **every Salesforce page** (including Setup, List Views, and standard layouts).
* **Keyboard Trigger:** Access the search palette via **`Ctrl + Space`** (Windows / Linux) or **`Option + Space`** (macOS).
* **Autocomplete Metadata Mapping:**
  * **OBJECT** (Green) — Standard, Custom, Managed Custom sObjects, and Custom Metadata Types (`__mdt`).
  * **CLASS** (Purple) — Local unmanaged Apex Classes.
  * **TRIGGER** (Orange) — Local unmanaged Apex Triggers.
  * **PAGE** (Blue) — Local unmanaged Visualforce Pages.
  * **LABEL** (Gold) — Local unmanaged Custom Labels.
  * **SETTING** (Teal) — Local unmanaged Custom Settings.
* **Setup Redirection Logic (Salesforce Classic):**
  * **Standard Objects:** Direct routing to the Fields Setup page via `/p/setup/layout/LayoutFieldList?type={ObjectName}`.
  * **Custom / Managed Objects & Custom Metadata:** Direct routing to their definition screen using their unique 15-character Classic Setup ID (with standard index lists as safe fallbacks).
  * **Custom Metadata Types:** Opens the CMDT definition screen. Maps using the **15-character Classic Setup ID** formatted as `/{15_char_id}?setupid=CustomMetadata` (falls back to `/01I?setupid=CustomMetadata` if not resolved).
  * **Apex / VF / Labels:** Routes to code editor or detail panels using unique IDs.

### 3. Performance & Resilience Design
* **Zero Page-Load Impact:** All metadata indexing is lazy-loaded (triggered only when the search panel is opened for the first time).
* **Parallel API Requests:** Background metadata compilation queries are run concurrently to reduce load latency.
* **Query Timeout Guard & Abort Signals:** A **2.2-second AbortController timeout** is attached to all concurrent fetches. If any query is slow or hangs, it aborts cleanly, and the search suggestions still load instantly with the remaining categories.
* **Enterprise Metadata Filter:** Filters Apex, Custom Settings, and Custom Labels to local/unmanaged items (`NamespacePrefix = null`), excluding thousands of packaged managed items that developers do not locally edit. This speeds up query times by 10x in large orgs.
* **Rendering Optimization:** Search results are sliced to the top 60 matches to prevent typing lag and DOM overhead.

### 4. Security & Authentication
* **Session Authorization:** Rides on the browser's active, authenticated session (`credentials: 'include'`). The extension does not store, request, or transmit user credentials.
* **Sid Cookie Extraction:** The background script reads the `sid` cookie valid for the Classic domain (`*.my.salesforce.com` or `*.sandbox.my.salesforce.com`), which acts as the OAuth Bearer token for REST requests.
* **Domain Guard:** Disabled on public-facing Salesforce portals (e.g. Trailhead, AppExchange, Help, Trust, success, and login pages) to prevent shortcut capture.

### 5. Multi-Domain Sandbox & Scratch Org Support
Matches and permissions are configured to support multi-subdomain sandbox and developer scratch org environments:
* `https://*.sandbox.lightning.force.com/*`
* `https://*.sandbox.my.salesforce.com/*`
* `https://*.develop.lightning.force.com/*`
* `https://*.develop.my.salesforce.com/*`

---

## 👨‍💻 About the Developer

**Abhishek Jaiswal**  
Developer, builder, and problem solver passionate about creating tools that make developers faster, more productive, and more effective.

With a focus on usability, automation, and clean engineering, I enjoy building products that remove friction from daily workflows and provide a delightful developer experience.

* **Email:** [jaiswal.abhishek@zohomail.in](mailto:jaiswal.abhishek@zohomail.in)
* **LinkedIn:** [Abhishek Jaiswal](https://www.linkedin.com/in/theabhishekjaiswal12/)

---
Developed with ❤️. Dedicated author links and custom micro-animations are built directly into the command palette footer.
