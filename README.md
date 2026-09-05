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

- **Check first:** a fixed, balanced set of previously taught facts, before hints, corrections or teaching. Its first answers alone determine the pass score. A new learner gets a short, untimed **starting check** with no pass/fail judgment while the app identifies a starting point.
- **Learn:** one or two facts by default, using a known double, an easier multiplication plus another group, or equal-group construction. Coloured arrays connect the steps to the mathematics. Each short lesson asks the child to complete intermediate steps and then the target fact; those answers remain guided evidence.
- **Practice:** a short, untimed adaptive round using taught facts and missed questions. Corrections return later with the same operation: a division miss must be answered as division.
- **Use what you know:** a missing-factor puzzle and a short contextual problem. Application results are separate from the check score.
- **Grown-ups** retain their selected tables, check length, pass mark, timing and division settings. Set **Teaching facts → Off** for just the check. New installations start with 2, 5 and 10; existing choices are preserved.

“Secure” requires successful unprompted recalls on later days, including a gap of at least three days and evidence spanning multiple days. Repeated same-day sessions cannot establish it. Progress displays observed retention rather than a claimed probability. Multiplication and related division retain separate records; timeouts are separate from wrong answers. Selected timing applies only to established facts in the check; all learning remains untimed.

Listen buttons use an installed English voice when one is available, so reading can be supported without an online tutor. The app remains static and offline-first.

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

