# Danny Times — notes

**Date:** 2026-08-25 · **App version:** 3.0.0 (data schema v5)

## 3.0.0 — teaching, independent checks and retention

The Start flow is now check → teach → practise → apply. A check freezes its question list before any answers or explanations are shown; its result cannot be changed by subsequent practice. Starting checks are unscored when fewer than six facts have been taught. Teaching Off keeps a strict check-only path.

Lessons use a known doubling or splitting strategy when available, with coloured arrays and intermediate steps. Two short application questions exercise a missing factor and a contextual quantity. Read-aloud uses installed local English voices only.

Memory evidence now distinguishes day-separated recall from immediate repetition. A guided exposure resets the retention interval. Secure requires at least three successful later-day checks, a gap of at least 72 hours, and five days between the first and latest retained checks. Old history is preserved, but labels can become more conservative until this evidence is collected. Timeouts do not count as conceptual mistakes or reduce stability, and only established check facts receive a time limit.

Division has its own optional progress record. Both immediate repair and the Fix the misses round preserve the question operation. Sync merges the two operation records independently and retains observed delayed recalls.

Storage schema remains v5 and sync payload remains v1, using additive fields. Existing settings and historical results are preserved. In-progress older sessions keep their legacy flow. New sessions persist their fixed check, teaching position and application state. Ending a learning phase preserves the completed check result.

Verification: unit regressions cover same-day overconfidence, warm-up contamination, delayed recall, timeout classification, fixed question selection, strategy prerequisites, operation-specific retries and backup/sync compatibility. Browser regressions cover assessment before teaching, honest scores, division repair, phone layout, resume and parent controls.

## 2.1.0 — timed questions (2026-08-25)

Settings → Each session → **Time per question**: Off / 3 s / 6 s / 10 s (6 s is
the pace of the Year 4 multiplication tables check; the list is `TIME_LIMITS` in
`src/core/storage.ts`). A draining bar sits under the equation. Running out counts
as a miss — recorded with `given: null`, corrected with the usual retype, retried
3–5 questions later — and shows as a clock in the result's missed list. Warm-up
and fix-the-misses rounds are never timed. The clock pauses while the tab is
hidden or the "End session?" prompt is open, so an interruption is not charged to
the answer.

Also fixed: a fact missed again *on its retry* was never re-queued. The app
removed the retry entry when moving to the next question, after the miss had
already rescheduled it, so the second retry was silently dropped — unlike the
simulator the v2 scheduler was validated with. Retries now clear on a correct
first answer and reschedule on a miss.

Back-compat: schema stays v5 and the sync payload stays version 1.
`timeLimitSeconds` is additive and back-filled to 0 by `ensureSettings`, so
older devices keep working; until updated they show a struck-through "null" for a
timed-out answer in the missed list.

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

