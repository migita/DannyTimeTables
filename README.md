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

One child-facing flow, started with a single **Start** button:

- **Warm-up** (off, 2, 3 or 5 facts) shows the facts most in need — new ones first, then shaky ones — with a visual explanation (groups, arrays, doubles, fives, tens), typed once with guidance. A guided answer never counts as mastery.
- **Questions** are a scored session (10/20/30/50 questions, configurable pass mark, optional related division) drawn from the adaptive scheduler: new facts arrive steadily, a fact never repeats within eight questions unless it was missed, and a missed fact returns 3–5 questions later after a retype correction. The score counts first answers only and ends in **PASS / NOT YET**, with a "Fix the misses" follow-up round.
- **Time per question** (off, 3, 6 or 10 s) adds a draining countdown under each scored question. Running out of time counts as a miss: it is corrected like any other, scheduled for retry, and shown with a clock in the missed list. Warm-up and fix-the-misses rounds are never timed, and the clock pauses while the app is hidden or the end-session prompt is open.
- **Grown-ups** can choose any tables from 1–12 (settings drive every session), inspect fact-level history, export/import a versioned backup, and reset local data.

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
