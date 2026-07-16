# Danny Times — notes

**Date:** 2026-07-16 · **App version:** 2.0.0 (data schema v5)

## What this is

A small offline-first PWA for Danny to learn his times tables on a phone or tablet.
Every fact (e.g. 7×4) has its own memory record — attempts, mistakes, response speed,
and an estimated memory stability — and the app schedules questions to practise each
fact just as it starts to fade (around ~75% recall). Progress syncs between family
devices through a tiny Cloudflare Worker using a shared family code.

## How it works now (v2)

One child-facing flow, started with a single **Start** button:

1. **Warm-up** (configurable: off/2/3/5) — the facts most in need (new ones first,
   then shaky ones) are shown with a visual explanation and typed once, guided.
2. **Questions** — a scored session (10/20/30/50 questions, pass mark configurable).
   Questions come from the adaptive scheduler; warmed-up facts return as real
   questions early on. A mistake shows a correction to retype and the fact comes
   back 3–5 questions later. The score counts first answers only → **PASS / NOT YET**,
   plus the existing "Fix the misses" follow-up.

Everything is configured in Settings: **active tables drive all of it** — warm-up,
questions, progress screens. Sessions persist, so a closed tab resumes or is
recorded honestly as stopped.

## Why it changed (2026-07-16)

- **Learn/Practice/Test felt like three apps.** Danny (and the grown-ups) treated
  practice as "the test" anyway, and the separate strict test was used exactly once
  (abandoned). The three modes are now one warm-up→test session.
- **Settings tables didn't do what anyone expected.** They only affected
  practice/learn; tests carried their own frozen table lists (still 2,3,5,10 —
  which is why adding table 4 never showed in a test). Now settings are the single
  source of truth; presets were retired.
- **Practice really was repetitive, and new facts starved.** Measured on the real
  family data: only ~11 distinct facts per 20-question session, the same
  never-missed facts asked 3× per session, table 4 stuck at 4 of 12 facts, and 28
  of 60 selected facts never shown at all. Root causes in the scheduler: a
  symmetric "useful difficulty" curve that ranked just-answered facts above
  forgotten ones, a new-fact boost that only fired every 5th question and lost to
  weak-fact bonuses anyway, and a no-repeat window of just 3 questions.

## Scheduler v2 (the fix)

- Difficulty curve made **asymmetric**: a fact answered moments ago scores ~0; a
  forgotten fact keeps most of its value; peak stays near the 72% recall target.
- **Steady introduction drip**: unseen facts enter only via the drip (~1 in 4
  questions while any remain, with catch-up if retries claim a slot), easiest facts
  of the least-covered table first — so a newly enabled table catches up fast.
- **No-repeat window of 8 questions** (hard), retries exempt.
- Warm-up facts are seeded as the session's first retries so teaching is
  immediately tested.

Simulated on Danny's actual synced state (10 seeds × 8 daily sessions, modelled
child): clean repeats per session **6.2 → 0.0**, never-seen facts after 8 sessions
**25.9 → 0.0**, distinct table-4 facts asked **7/12 → 11/12**. Regression thresholds
live in `tests/simulation.test.ts`.

Old devices on the same family code keep working: the sync payload shape is
unchanged (legacy presets/practice history are carried, frozen), and settings from
older devices are back-filled with session defaults on arrival.
