// ============================================================================
//  Runaway · lbi-bridge tests
//  Run with: npm test   (node --test, no dependencies)
//
//  Every test here corresponds to a way the export could be wrong in a way no
//  one would notice:
//    - counting a friend's runs as yours (fetchRuns returns theirs too)
//    - counting runs, not days
//    - reporting minutes per WEEK where LBI expects minutes per DAY
//    - a padded ISO week key, which LBI would read as a different week forever
//    - claiming days that have not happened yet
//    - leaking a run note or a display name into a key any page can read
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunawayPayload,
  lbiIsoWeekKey,
  lbiWeekStart,
  lbiDateStr,
} from '../lbi-bridge.js';

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

// A run row shaped like one from Postgres. duration_min is nullable there, so
// the default here is an explicit null rather than an omitted key.
function run(date, duration = null, userId = ME, extra = {}) {
  return { user_id: userId, run_date: date, duration_min: duration, ...extra };
}

// Local midday, so a timezone shift of a few hours cannot move the date.
function at(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

// Monday 2026-08-03 .. Sunday 2026-08-09. Verified weekdays, not assumed.
const MONDAY = '2026-08-03';
const SUNDAY = '2026-08-09';

// --- the week -------------------------------------------------------------

test('the window runs Monday to Sunday of the week containing today', () => {
  const p = buildRunawayPayload([], ME, at('2026-08-06'));
  assert.equal(p.window.from, MONDAY);
});

test('on a Sunday the week starts on the PRECEDING Monday, not the next one', () => {
  // getDay() is 0 on Sunday; the naive "subtract getDay() days" lands on the
  // same Sunday and reports a week that has not begun.
  assert.equal(lbiDateStr(lbiWeekStart(at(SUNDAY))), MONDAY);
});

test('mid-week the window ends today, not on Sunday', () => {
  const p = buildRunawayPayload([], ME, at('2026-08-05'));
  assert.equal(p.window.to, '2026-08-05');
});

test('on Sunday the window ends on Sunday', () => {
  const p = buildRunawayPayload([], ME, at(SUNDAY));
  assert.equal(p.window.to, SUNDAY);
});

test('the ISO week key is UNPADDED, matching LBI isoWeekKey', () => {
  // "2026-W03" also matches LBI's regex, so a padded key passes validation and
  // then compares unequal to LBI's own "2026-W3" — a connection that silently
  // reads as stale for the first nine weeks of every year.
  assert.equal(lbiIsoWeekKey(at('2026-01-15')), '2026-W3');
});

test('the ISO week key follows the ISO year across a New Year boundary', () => {
  // 2027-01-01 is a Friday, so its Thursday falls in 2026 — ISO week 2026-W53.
  assert.equal(lbiIsoWeekKey(at('2027-01-01')), '2026-W53');
});

test('the date string is the LOCAL calendar date, not a UTC shift', () => {
  // toISOString() would report the previous day for any evening in UTC+7.
  assert.equal(lbiDateStr(new Date(2026, 7, 3, 23, 30, 0)), '2026-08-03');
});

// --- whose runs -----------------------------------------------------------

test("a friend's runs are never counted as yours", () => {
  // fetchRuns returns friends' and club members' runs as well — the "View runs"
  // policy grants select on both. Exporting unfiltered would score someone
  // else's marathon as this user's exercise.
  const p = buildRunawayPayload([
    run('2026-08-04', 30),
    run('2026-08-05', 45, FRIEND),
    run('2026-08-06', 60, FRIEND),
  ], ME, at('2026-08-07'));

  assert.equal(p.facts.activeDays, 1);
  assert.equal(p.facts.totalMinutes, 30);
});

test('no signed-in user means no payload at all', () => {
  assert.equal(buildRunawayPayload([run('2026-08-04', 30)], null, at('2026-08-07')), null);
});

// --- the counts -----------------------------------------------------------

test('active days counts distinct DATES, not runs', () => {
  const p = buildRunawayPayload([
    run('2026-08-04', 20),
    run('2026-08-04', 25),
    run('2026-08-06', 30),
  ], ME, at('2026-08-07'));

  assert.equal(p.facts.activeDays, 2);
  assert.equal(p.facts.totalMinutes, 75);
});

test('minutes are PER ACTIVE DAY: 102 minutes over 3 days is 34, not 102', () => {
  const p = buildRunawayPayload([
    run('2026-08-03', 30),
    run('2026-08-05', 40),
    run('2026-08-07', 32),
  ], ME, at('2026-08-08'));

  assert.equal(p.facts.totalMinutes, 102);
  assert.equal(p.facts.activeDays, 3);
  assert.equal(p.facts.minutesPerActiveDay, 34);
});

test('a run with no duration is an active day but contributes no minutes', () => {
  const p = buildRunawayPayload([
    run('2026-08-04', 40),
    run('2026-08-06', null),
  ], ME, at('2026-08-07'));

  assert.equal(p.facts.activeDays, 2);
  assert.equal(p.facts.totalMinutes, 40);
  assert.equal(p.facts.runsWithoutDuration, 1);
  // 40 over 2 days — understated, which is why runsWithoutDuration is reported
  // rather than the day being quietly dropped from the divisor.
  assert.equal(p.facts.minutesPerActiveDay, 20);
});

test('runs outside the week are excluded at both ends', () => {
  const p = buildRunawayPayload([
    run('2026-08-02', 60),  // the previous Sunday
    run('2026-08-04', 30),
    run('2026-08-10', 90),  // the following Monday
  ], ME, at('2026-08-09'));

  assert.equal(p.facts.activeDays, 1);
  assert.equal(p.facts.totalMinutes, 30);
});

test('a run dated later this week is not counted before that day arrives', () => {
  const p = buildRunawayPayload([
    run('2026-08-03', 30),
    run('2026-08-08', 45),  // Saturday, while today is Wednesday
  ], ME, at('2026-08-05'));

  assert.equal(p.facts.activeDays, 1);
  assert.equal(p.facts.totalMinutes, 30);
  assert.equal(p.window.to, '2026-08-05');
});

test('a week with no runs is published as real zeros', () => {
  // Withholding it would leave last week's payload standing as if it were
  // current. "I did not run" is a measurement.
  const p = buildRunawayPayload([], ME, at('2026-08-05'));

  assert.equal(p.facts.activeDays, 0);
  assert.equal(p.facts.totalMinutes, 0);
  assert.equal(p.facts.minutesPerActiveDay, 0);
  assert.equal(p.facts.runsWithoutDuration, 0);
});

test('a nonsense duration is clamped to the contract ceiling, not sent raw', () => {
  // 99999 minutes would fail LBI's range check and take the whole payload with
  // it, leaving LBI showing nothing. Clamped, the week stays usable and the
  // wrong figure stays visible in a field the user confirms before submitting.
  const p = buildRunawayPayload([run('2026-08-04', 99999)], ME, at('2026-08-05'));

  assert.equal(p.facts.totalMinutes, 10080);
  assert.equal(p.facts.minutesPerActiveDay, 1440);
});

// --- the contract ---------------------------------------------------------

test('the payload has exactly the shape LBI validates', () => {
  const p = buildRunawayPayload([run('2026-08-04', 30)], ME, at('2026-08-05'));

  assert.equal(p.v, 1);
  assert.equal(p.source, 'runaway');
  assert.ok(Number.isFinite(Date.parse(p.writtenAt)));
  assert.deepEqual(Object.keys(p.window).sort(), ['from', 'isoWeek', 'to']);
  assert.deepEqual(
    Object.keys(p.facts).sort(),
    ['activeDays', 'minutesPerActiveDay', 'runsWithoutDuration', 'totalMinutes'],
  );
});

test('no free text and no PII reach the payload', () => {
  // Any page on the origin can read this key. Notes and display names are the
  // two places a person's own words live on a run row.
  const hostile = '<img src=x onerror=alert(1)>';
  const p = buildRunawayPayload([
    run('2026-08-04', 30, ME, {
      notes: hostile,
      profiles: { display_name: hostile, avatar_url: 'https://example.test/a.png' },
    }),
  ], ME, at('2026-08-05'));

  const raw = JSON.stringify(p);
  assert.equal(raw.includes('onerror'), false);
  assert.equal(raw.includes('<'), false);
  assert.equal(raw.includes('example.test'), false);
  // and the run itself was still counted, so this is not passing by dropping it
  assert.equal(p.facts.totalMinutes, 30);
});

test('the user id is not in the payload either', () => {
  const p = buildRunawayPayload([run('2026-08-04', 30)], ME, at('2026-08-05'));
  assert.equal(JSON.stringify(p).includes(ME), false);
});
