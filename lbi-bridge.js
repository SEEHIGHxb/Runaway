// ============================================================================
//  Runaway · Life Balance Index bridge
//  Publishes this ISO week's running as aggregate facts on a same-origin
//  localStorage key that the Life Balance Index reads. Off until switched on
//  from the Profile tab.
//
//  Four rules govern the handoff, and each is load-bearing:
//    1. Facts, not scores. Scoring rules live in LBI and get recalibrated; a
//       score shipped from here would freeze an old calibration into a repo
//       that does not know it moved.
//    2. Every payload carries the window it covers, so LBI can refuse one that
//       does not match the week being reviewed.
//    3. A version field, so the shape can change without a silent misread.
//    4. No free text and no PII. No display names, no run notes — aggregates
//       only. Any page on the origin can read this key, and rule 4 keeps the
//       blast radius of that fact at zero.
// ============================================================================

import { state } from './state.js';
import { $ } from './util.js';

export const LBI_BRIDGE_KEY = 'lbi_bridge_runaway';
export const LBI_EXPORT_PREF_KEY = 'runaway_lbi_export';

const LBI_BRIDGE_VERSION = 1;

// The ceilings LBI's validator enforces (connections.js FACT_SPECS.runaway). A
// duration typo above these would otherwise fail the whole payload and leave
// LBI showing nothing at all; clamping keeps the rest of the week usable and
// the wrong number visible, and the review pre-fills rather than auto-applies,
// so the user still corrects it before it reaches a score.
const LBI_MAX_TOTAL_MINUTES = 10080;
const LBI_MAX_MINUTES_PER_DAY = 1440;

// ---------------------------------------------------------------------------
//  Pure date helpers
// ---------------------------------------------------------------------------

// Local calendar date as YYYY-MM-DD. Built field by field rather than through
// toISOString(), which converts to UTC first and hands back yesterday for
// anyone east of Greenwich after midnight — this app runs in UTC+7.
export function lbiDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Local midnight on the Monday of `date`'s week. Local, not UTC: a week
// boundary is a fact about the runner's calendar. Matches util.js rangeCutoff,
// which slices the leaderboard's "This week" the same way.
export function lbiWeekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() || 7) - 1));
  return d;
}

// The ISO week key, DELIBERATELY UNPADDED ("2026-W3", not "2026-W03").
//
// This is not a style choice. LBI decides a Runaway payload is fresh by string
// equality against its own isoWeekKey (connections.js payloadFreshness ->
// season.js isoWeekKey), and that function is unpadded because the same string
// is already stored in every existing save as reviews[].week. A padded key here
// would compare unequal for weeks 1-9 and the connection would silently read
// as stale every January.
export function lbiIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

// ---------------------------------------------------------------------------
//  Aggregation
// ---------------------------------------------------------------------------

// A duration that can be counted. duration_min is nullable in the schema
// (schema.sql: "duration_min numeric check (duration_min is null or > 0)"), so
// a distance-only run is normal, not corrupt.
function lbiMinutesOf(run) {
  const min = Number(run.duration_min);
  return Number.isFinite(min) && min > 0 ? min : null;
}

// Build the payload for the week containing `today`, or null when there is no
// signed-in runner to attribute the runs to.
//
// `runs` is the same array app.js holds in state.runs, which is what fetchRuns
// returned — and fetchRuns returns runs belonging to FRIENDS AND CLUB MEMBERS
// as well (schema.sql "View runs" grants select on both). Exporting that
// unfiltered would count other people's exercise as the user's own, so every
// run is matched against myId before anything is summed.
export function buildRunawayPayload(runs, myId, today) {
  if (!myId) return null;

  const monday = lbiWeekStart(today);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

  const from = lbiDateStr(monday);
  const todayStr = lbiDateStr(today);
  const sundayStr = lbiDateStr(sunday);
  // Mid-week the window ends today, not on Sunday. A week is reported as far as
  // it has actually been lived; claiming through Sunday on a Wednesday would
  // describe days that have not happened. ISO dates compare correctly as
  // strings, which is also how run_date arrives from Postgres.
  const to = todayStr < sundayStr ? todayStr : sundayStr;

  const mine = (Array.isArray(runs) ? runs : []).filter((r) => (
    r && r.user_id === myId
    && typeof r.run_date === 'string'
    && r.run_date >= from
    && r.run_date <= to
  ));

  // Distinct DATES, not run count: two runs on the same evening is one active
  // day. LBI's weeklyVigorousDays is a day count and maxes out at 7.
  const activeDays = new Set(mine.map((r) => r.run_date)).size;

  let totalMinutes = 0;
  let runsWithoutDuration = 0;
  for (const run of mine) {
    const min = lbiMinutesOf(run);
    if (min === null) runsWithoutDuration += 1;
    else totalMinutes += min;
  }
  totalMinutes = Math.min(Math.round(totalMinutes), LBI_MAX_TOTAL_MINUTES);

  // Minutes PER ACTIVE DAY, not per week — LBI's weeklyVigorousMins is a
  // per-day field. A 102-minute, 3-day week is 34, not 102. LBI recomputes this
  // from totalMinutes and activeDays and ignores what is sent here, so the two
  // apps cannot drift; it travels for display only.
  const minutesPerActiveDay = activeDays > 0
    ? Math.min(Math.round(totalMinutes / activeDays), LBI_MAX_MINUTES_PER_DAY)
    : 0;

  return {
    v: LBI_BRIDGE_VERSION,
    source: 'runaway',
    writtenAt: new Date().toISOString(),
    window: { isoWeek: lbiIsoWeekKey(today), from, to },
    // A week with no runs is published, not withheld. Unlike a ledger with no
    // transactions, "I did not run this week" is a real measurement, and
    // withholding it would let the previous week's numbers stand as if they
    // were current.
    facts: { activeDays, minutesPerActiveDay, totalMinutes, runsWithoutDuration },
  };
}

// ---------------------------------------------------------------------------
//  Preference + writing
// ---------------------------------------------------------------------------

export function isLbiExportEnabled() {
  try {
    return localStorage.getItem(LBI_EXPORT_PREF_KEY) === 'on';
  } catch (_) {
    return false;
  }
}

function setLbiExportEnabled(on) {
  try {
    localStorage.setItem(LBI_EXPORT_PREF_KEY, on ? 'on' : 'off');
  } catch (_) {
    // A blocked store means the choice cannot persist; the write below still
    // reflects it for this session rather than failing the click outright.
  }
}

// Write the current week, or clear the key. Called after every successful runs
// fetch, so the shared figures track the live feed.
//
// Never throws: a full or blocked localStorage must not take down the runs
// list, which is the actual app.
export function refreshLbiBridge() {
  let payload = null;
  if (isLbiExportEnabled()) {
    payload = buildRunawayPayload(state.runs, state.me && state.me.id, new Date());
  }
  try {
    if (payload) localStorage.setItem(LBI_BRIDGE_KEY, JSON.stringify(payload));
    else localStorage.removeItem(LBI_BRIDGE_KEY);
  } catch (err) {
    console.warn('Could not update the Life Balance Index bridge:', err.message);
  }
  renderLbiStatus(payload);
  return payload;
}

// Signing out revokes the export. The runs were shared as a signed-in user's
// own; leaving them readable on a shared browser after sign-out would hand them
// to whoever signs in next.
export function clearLbiBridge() {
  try {
    localStorage.removeItem(LBI_BRIDGE_KEY);
  } catch (_) {
    // Nothing to do — the key is unreachable, so it is not being read either.
  }
}

// ---------------------------------------------------------------------------
//  Profile-tab switch (the theme-seg idiom, as used by theme.js/notifications.js)
// ---------------------------------------------------------------------------

function renderLbiStatus(payload) {
  const el = $('#lbi-export-status');
  if (!el) return;

  if (!isLbiExportEnabled()) {
    el.textContent = 'Off. Nothing is shared, and anything shared earlier has been cleared.';
    return;
  }
  if (!payload) {
    el.textContent = 'On. Sign in to share this week.';
    return;
  }

  const { activeDays, totalMinutes, runsWithoutDuration } = payload.facts;
  const days = `${activeDays} ${activeDays === 1 ? 'day' : 'days'}`;
  let text = `Sharing ${days} and ${totalMinutes} min for ${payload.window.isoWeek} (${payload.window.from} to ${payload.window.to}).`;
  if (runsWithoutDuration > 0) {
    text += ` ${runsWithoutDuration} ${runsWithoutDuration === 1 ? 'run has' : 'runs have'} no duration, so the minutes may be understated.`;
  }
  el.textContent = text;
}

function applyLbiUiChoice(choice) {
  const seg = $('#lbi-switch');
  if (!seg) return;
  seg.querySelectorAll('.theme-seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lbiChoice === choice);
  });
  const activeIndex = choice === 'on' ? 1 : 0;
  const handleWidth = seg.offsetWidth / 2 - 2;
  seg.style.setProperty('--handle-offset', `${activeIndex * handleWidth}px`);
}

export function initLbiBridge() {
  const seg = $('#lbi-switch');
  if (!seg) return;

  applyLbiUiChoice(isLbiExportEnabled() ? 'on' : 'off');
  renderLbiStatus(null);

  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lbi-choice]');
    if (!btn) return;
    const choice = btn.dataset.lbiChoice === 'on' ? 'on' : 'off';
    setLbiExportEnabled(choice === 'on');
    applyLbiUiChoice(choice);
    refreshLbiBridge();
  });

  window.addEventListener('resize', () => {
    const active = seg.querySelector('.theme-seg-btn.active');
    if (active) applyLbiUiChoice(active.dataset.lbiChoice);
  });

  setTimeout(() => { seg.classList.add('seg-ready'); }, 100);
}

// initLbiBridge runs while the Profile panel is still hidden, so offsetWidth is
// 0 and the handle parks at the far left. app.js calls this once the panel is
// shown — the same fix resyncNotifyHandle makes for the push toggle.
export function resyncLbiHandle() {
  const seg = $('#lbi-switch');
  if (!seg) return;
  const active = seg.querySelector('.theme-seg-btn.active');
  if (active) applyLbiUiChoice(active.dataset.lbiChoice);
  refreshLbiBridge();
}
