# Danny Times

A lightweight, offline-first times-tables trainer for a child entering Year 2 in the UK. It combines short visual lessons, adaptive retrieval practice, and strict parent-configured tests.

## Run locally

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Progress is stored only in the browser.

## Verify

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs the unit suite, production build, and browser suite together.

## Product structure

- **Learn** uses groups, arrays, doubles, fives, and tens before asking for an independent answer. A guided correction never counts as mastery.
- **Practice** targets facts near useful retrieval difficulty. Recent mistakes return after 3–5 intervening questions, while stable facts are checked less often.
- **Just Test** generates a balanced, fixed-difficulty sequence. It hides correctness during the run, persists every answer, and records abandoned tests separately from passes and failures. Test answers feed the memory model, the result screen shows the finish time, and missed questions can be fixed immediately in a short retype-and-recall round. A built-in "Screen time" preset (20 questions, pass 18, core tables) matches a typical school test.
- **Grown-ups** can choose any tables from 1–12, inspect prompt-level history, save test presets, export/import a versioned backup, and reset local data.

The memory model and test generator are pure TypeScript modules under [`src/core`](src/core). The browser interface is kept in [`src/app.ts`](src/app.ts), and local persistence is isolated in [`src/core/storage.ts`](src/core/storage.ts).

## Family sync

Progress can be kept in step across devices through a tiny Cloudflare Worker (`sync-worker/`) storing one JSON blob per family in Workers KV. Devices authenticate with a shared family code and never talk to Cloudflare directly — enter the code once per device under **Grown-ups → Settings → Family sync**.

Sync is merge-based, not last-writer-wins: test and practice history union by id (a pass recorded offline can never be lost), each fact keeps whichever device reviewed it last, and settings follow the most recent explicit change. Writes use `If-Match` versioning, so concurrent devices re-pull and re-merge instead of clobbering each other. The family code and any half-finished test stay device-local.

To (re)deploy the backend:

```bash
cd sync-worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put FAMILY_CODE   # paste a long random code; same one goes into each device
```

The endpoint URL lives in `src/core/sync.ts` (`SYNC_ENDPOINT`). Rotating the family code is `wrangler secret put FAMILY_CODE` again, then re-entering it on each device.

## Offline and installation

The production build is a static PWA. Its service worker pre-caches the generated Vite bundles and install assets, then caches same-origin requests as they are used. On iPhone, open the deployed site in Safari and use **Add to Home Screen**.

```bash
npm run build
npm run preview
```

The complete static site is emitted to `dist/`.

## GitHub Pages

The repository includes CI and Pages workflows. After pushing to GitHub:

1. Open **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Run the **Deploy GitHub Pages** workflow, or push to `main`.

All asset paths are relative, so project Pages URLs work without repository-specific build configuration.
