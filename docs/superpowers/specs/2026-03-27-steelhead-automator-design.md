# SteelheadAutomator — Design Spec

## Context

The Ecoplating team uses Steelhead ERP (app.gosteelhead.com) for operations. Currently, repetitive tasks like bulk data loading are done via bookmarklets that require manual copy-paste of JavaScript into each user's browser — fragile, hard to update, and impossible to govern.

This project migrates that automation into a Chrome Extension with remote script loading, enabling:
- One-click installation via Chrome Web Store (unlisted)
- Automatic updates to business logic without reinstalling
- A clean UI for non-technical users (2-10 people)
- Reusable Claude skills to maintain Steelhead API knowledge over time

## Architecture: Remote Script Loader

### Overview

The extension is a thin "shell" (Manifest V3) that activates on `app.gosteelhead.com`. On page load, it fetches the latest configuration and scripts from GitHub Pages. Business logic lives in the remote repo, not in the extension — a `git push` updates all users immediately.

```
Chrome Extension (shell)          GitHub Pages (CDN)         Steelhead ERP
┌──────────────────────┐     ┌──────────────────────┐    ┌─────────────────┐
│ manifest.json (MV3)  │     │ config.json          │    │ GraphQL API     │
│ service worker       │────>│ scripts/             │───>│ (persistent     │
│ content script       │     │ templates/           │    │  queries +      │
│ popup (UI)           │     │                      │    │  hashes)        │
└──────────────────────┘     └──────────────────────┘    └─────────────────┘
```

### Flow

1. User navigates to `app.gosteelhead.com`
2. Content script activates (via manifest `matches`)
3. Content script fetches `config.json` from GitHub Pages
4. Compares remote version with cached version (`chrome.storage.local`)
5. If newer: downloads updated scripts, caches them
6. Scripts are available for execution via popup buttons

### Update Model

- **Business logic (scripts, hashes, templates):** Updated via `git push` to GitHub Pages. Users get updates on next Steelhead page load. No reinstall needed.
- **Extension shell (manifest, popup UI):** Updated via Chrome Web Store. Only needed for permission changes or UI overhauls. Rare.

## Repo Structure

```
SteelheadAutomator/
├── extension/                        # Chrome extension (shell) — published to CWS
│   ├── manifest.json                 # MV3, permissions for app.gosteelhead.com
│   ├── background.js                 # Service worker
│   ├── content.js                    # Content script: fetches + caches remote scripts
│   ├── popup.html                    # UI: action buttons, status indicators
│   ├── popup.js                      # Popup logic
│   └── icons/                        # Extension icons (16, 48, 128px)
│
├── remote/                           # Published to GitHub Pages
│   ├── config.json                   # Version, current hashes, endpoint map
│   ├── scripts/
│   │   ├── steelhead-api.js          # API client: auth headers, persistent queries
│   │   ├── bulk-upload.js            # Excel parsing + bulk API calls
│   │   └── hash-scraper.js           # Hash re-discovery logic
│   └── templates/
│       └── plantilla-carga-masiva.xlsx  # Downloadable Excel template
│
├── tools/                            # Local dev/maintenance scripts
│   └── update-hashes.js              # Run locally to scrape + update config.json
│
├── skills/                           # Claude skills for Steelhead knowledge
│   ├── steelhead-api-map.md          # Endpoints, queries, hashes, payloads
│   ├── steelhead-hash-scraping.md    # Process to re-discover hashes
│   └── steelhead-patterns.md         # Auth, pagination, chaining patterns
│
├── docs/
│   └── superpowers/specs/            # Design specs
│
└── CLAUDE.md                         # Project-level instructions for Claude
```

## Components

### 1. Extension Shell (extension/)

**manifest.json (MV3)**
- `permissions`: `activeTab`, `storage`, `scripting`
- `host_permissions`: `https://app.gosteelhead.com/*`
- `content_scripts`: matches `https://app.gosteelhead.com/*`
- `action`: popup with branded icon and name

**content.js**
- Activates on `app.gosteelhead.com`
- Fetches `config.json` from GitHub Pages URL
- Version-checks against `chrome.storage.local`
- Downloads and caches scripts if version is newer
- Exposes a message API for popup.js to trigger actions

**popup.html / popup.js**
- Branded UI with company/project logo
- Buttons: "Cargar Excel", "Descargar Plantilla", "Ver Estado"
- Shows current version, connection status, last sync time
- "Cargar Excel" opens file picker, reads .xlsx, sends data to content script

**background.js (service worker)**
- Listens for extension install/update events
- Could handle alarm-based periodic config checks (future)

### 2. Remote Scripts (remote/)

**config.json**
```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-03-27",
  "steelhead": {
    "baseUrl": "https://app.gosteelhead.com",
    "graphqlEndpoint": "/graphql",
    "hashes": {
      "createOrder": "abc123...",
      "updateOrder": "def456...",
      "bulkCreate": "ghi789..."
    }
  },
  "scripts": [
    "scripts/steelhead-api.js",
    "scripts/bulk-upload.js"
  ]
}
```

**steelhead-api.js**
- Wraps fetch calls to Steelhead's GraphQL API
- Uses persistent query hashes from config.json
- Handles auth (reuses session cookies from the active Steelhead tab)
- Error handling and retry logic

**bulk-upload.js**
- Depends on SheetJS (xlsx) for parsing Excel files
- Reads rows from the template
- Maps columns to Steelhead API fields
- Executes bulk mutations with progress tracking
- Reports success/failure per row

**hash-scraper.js**
- Intercepts network requests to identify GraphQL persistent query hashes
- Can be triggered manually by admin to update config.json
- Outputs new hashes for manual or automated config update

**catalog-fetcher.js**
- Queries Steelhead API for fresh catalog data: Clientes, Procesos, Productos, Etiquetas, Specs, Racks
- Uses the user's active session (cookies) to authenticate
- Returns structured catalog data for embedding in the Excel template
- Queries used: CustomerSearchByName, AllProcesses, SearchProducts, AllLabels, SearchSpecsForSelect, TempSpecFieldsAndOptions, AllRackTypes

### 3. Excel Template (remote/templates/)

- Generated dynamically with fresh catalog data when user clicks "Descargar Plantilla"
- Uses SheetJS to build the Excel in-browser with a "Listas" sheet pre-populated from Steelhead API
- 61 columns (A-BI), header section + data rows
- Catalogs auto-updated: Clientes, Procesos, Productos, Etiquetas, Specs, Racks (same logic as VBA_Module2 but fetched live from API)
- Base template structure versioned in remote/templates/

### 4. Claude Skills (skills/)

**steelhead-api-map.md**
- Living document of all discovered endpoints
- Persistent query names, hashes, request payloads, response schemas
- Updated as new APIs are discovered

**steelhead-hash-scraping.md**
- Step-by-step process to re-discover hashes when Steelhead updates them
- Which pages to visit, which network requests to intercept
- How to extract hashes from traffic
- How to update config.json

**steelhead-patterns.md**
- Authentication: how Steelhead handles sessions/tokens
- How to reuse the user's active session from the browser
- Pagination patterns for list queries
- How to chain mutations (create → add lines → update status)

## Deployment

### GitHub Pages Setup
1. Enable GitHub Pages on the `main` branch, serving from `/remote` directory
2. URL pattern: `https://<username>.github.io/SteelheadAutomator/`
3. config.json and scripts are immediately available after push

### Chrome Web Store (Unlisted)
1. Create Chrome Web Store developer account ($5 USD one-time)
2. Package `extension/` folder as .zip
3. Upload with unlisted visibility — only people with the direct link can find/install it
4. Branding: custom name, description, icons, screenshots
5. Updates to the shell are rare; logic updates go through GitHub Pages

### Installation for Users
1. Admin shares the Chrome Web Store link
2. User clicks "Add to Chrome"
3. Extension activates automatically on app.gosteelhead.com
4. Done — no technical knowledge required

## Core Flows

### Flow 1: Bulk Upload from Excel
1. User downloads template from popup → "Descargar Plantilla"
2. Fills in data in Excel
3. Opens Steelhead in Chrome
4. Clicks extension icon → "Cargar Excel"
5. Selects filled Excel file
6. Extension reads Excel, validates columns
7. Sends rows as persistent query mutations to Steelhead API
8. Shows progress bar and per-row success/failure

### Flow 2: Hash Re-discovery (Admin)
1. Steelhead updates their hashes (queries stop working)
2. Admin opens Steelhead, clicks "Scrape Hashes" (or runs local tool)
3. Script intercepts network traffic, extracts new hashes
4. Admin updates config.json with new hashes
5. Pushes to GitHub → all users get updated hashes on next reload

### Flow 3: Auto-update Logic
1. User opens Steelhead
2. Content script fetches config.json from GitHub Pages
3. Compares version with local cache
4. If newer: downloads new scripts, updates cache
5. User gets latest logic without any action

## Verification Plan

1. **Extension loads:** Install unpacked extension, navigate to app.gosteelhead.com, verify content script injects
2. **Remote fetch works:** Verify config.json is fetched from GitHub Pages, scripts are cached
3. **Popup UI:** Verify buttons render, "Descargar Plantilla" downloads the correct file
4. **Bulk upload (small):** Upload a 2-3 row Excel, verify rows are created in Steelhead
5. **Version update:** Bump version in config.json, push, reload Steelhead, verify new version is fetched
6. **Chrome automation:** Use claude-in-chrome tools to verify flows end-to-end

## Pending: Steelhead API Context

A detailed technical document from the Ecoplating chat is pending. It will contain:
- Exact persistent query hashes currently in use
- GraphQL endpoint details and payload structures
- Authentication/session handling specifics
- Known limitations or quirks of the Steelhead API

This document will populate the skills files and config.json with real data.

## Out of Scope (for v1)

- Multi-step workflow automation (create → add lines → change status)
- User roles or per-user configuration
- Offline support
- Side panel UI (popup is sufficient for v1)
- Automated CI/CD pipeline for Chrome Web Store publishing
