import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const origin = 'http://admin-hours.test';
let browser;
before(async () => { browser = await chromium.launch(); });
after(() => browser?.close());

// Run the real admin guard, overview, date controls and shift editors against test records.
function installClient() {
  const worker = { id: 'morgan', display_name: 'Morgan Lee', active: true };
  const roster = [worker, { id: 'alex', display_name: 'Alex Park', active: true }];
  const shifts = [
    { id: 'overnight', employee_id: worker.id, clock_in: '2026-11-01T03:00:00Z', clock_out: '2026-11-01T09:00:00Z' },
    { id: 'monday', employee_id: worker.id, clock_in: '2026-10-26T13:00:00Z', clock_out: '2026-10-26T17:00:00Z' },
    { id: 'open', employee_id: 'alex', clock_in: '2026-11-01T10:00:00Z', clock_out: null },
  ];
  window.weekQueries = [];
  window.fixtureShifts = shifts;
  window.writes = [];
  window.OffsiteWork = { loadAdmin: async () => {}, busy: () => false };
  window.supabase = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'admin' } } } }),
      getUser: async () => ({ data: { user: { id: 'admin' } } }),
    },
    channel: () => ({ on() { return this; }, subscribe() {} }),
    from(table) {
      let rows = table === 'time_entries' ? [...shifts] : table === 'employees' ? [...roster] : [];
      let end, start;
      return {
        select(fields) {
          if (table === 'time_entries' && fields.includes('breaks:time_breaks')) {
            rows = rows.map(r => ({ ...r, breaks: r.breaks ?? [] }));
          }
          return this;
        },
        order() { return this; },
        eq(k, v) { rows = rows.filter(r => r[k] === v); return this; },
        is(k, v) { return this.eq(k, v); },
        in(k, vs) { rows = rows.filter(r => vs.includes(r[k])); return this; },
        gte(k, v) { rows = rows.filter(r => Date.parse(r[k]) >= Date.parse(v)); return this; },
        lt(k, v) { end = v; rows = rows.filter(r => Date.parse(r[k]) < Date.parse(v)); return this; },
        not(k) { rows = rows.filter(r => r[k] != null); return this; },
        or(filter) {
          start = filter.match(/^clock_out\.gt\.(.+),clock_out\.is\.null$/)[1];
          rows = rows.filter(r => !r.clock_out || Date.parse(r.clock_out) > Date.parse(start));
          return this;
        },
        async range(first, last) {
          weekQueries.push({ start, end, first, last });
          if (window.failNext) { window.failNext = false; return { error: { message: 'Offline' } }; }
          if (window.holdNext) {
            window.holdNext = false;
            await new Promise(resolve => { window.releaseWeek = resolve; });
          }
          return { data: rows.slice(first, last + 1) };
        },
        maybeSingle: async () => ({ data: { role: 'admin', active: true } }),
        single: async () => ({ data: rows[0] }),
        then(resolve) { resolve({ data: rows }); },
      };
    },
    async rpc(name, args) {
      writes.push({ name, args });
      if (name === 'admin_correct_shift_time') {
        Object.assign(shifts.find(s => s.id === args._time_entry_id),
          { clock_in: args._new_clock_in, clock_out: args._new_clock_out });
      }
      if (name === 'admin_close_open_shift') {
        shifts.find(s => s.id === args._time_entry_id).clock_out = args._clock_out;
      }
      if (name === 'admin_create_manual_shift') {
        shifts.push({ id: 'manual', employee_id: args._employee_id, clock_in: args._clock_in, clock_out: args._clock_out });
        return { data: { id: 'manual' } };
      }
      return { data: [] };
    },
  };
}

async function open(t, width = 1200) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', locale: 'en-US' });
  t.after(() => context.close());
  await context.addInitScript(installClient);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const filename = url.pathname.slice(1);
    if (!/^[\w-]+\.(html|css|js)$/.test(filename)) return route.abort();
    let body = await readFile(new URL(filename, root), 'utf8');
    if (filename === 'admin.html') {
      const scripts = new Set(['admin.js', 'admin-overview.js', 'admin-weekly-hours.js', 'admin-schedule.js',
        'admin-shell.js', 'admin-stores.js', 'time-correction-core.js']);
      body = body.replace(/<script\b[\s\S]*?<\/script>/gi, tag =>
        scripts.has(tag.match(/src="([^"?]+)/)?.[1]) ? tag : '');
    }
    return route.fulfill({ body, contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.clock.setFixedTime(new Date('2026-11-01T18:00:00Z'));
  await page.goto(origin + '/admin.html');
  await expect(page.locator('#whTotal')).toHaveText('5h 00m');
  return page;
}

for (const width of [320, 1200]) test(`${width}px presets, DST boundary, expansion, navigation and saved preference`, async t => {
  const page = await open(t, width);
  const morgan = page.locator('[data-worker="morgan"]');
  await expect(page.locator('#whRange')).toContainText('Nov 1');
  await morgan.locator('summary').click();
  await expect(morgan.locator('.wh-shift-hours')).toHaveText('5h 00m in selected dates');
  await expect(page.locator('[data-worker="alex"] summary')).toContainText('1 open');
  await page.getByRole('button', { name: 'Monday through Sunday' }).click();
  await expect(page.locator('#whTotal')).toHaveText('10h 00m');
  await expect(morgan.locator('.wh-shift')).toHaveCount(2);
  await expect(morgan.locator('.wh-shift').first()).toBeVisible();
  await page.locator('#weeklyHours').screenshot({ path: `test-results/admin-weekly-hours-${width}.png` });
  // Include earlier breaks in store days that straddle the Eastern range boundary.
  assert.deepEqual((await page.evaluate(() => weekQueries.at(-1))).start, '2026-10-24T16:00:00.000Z');
  assert.deepEqual((await page.evaluate(() => weekQueries.at(-1))).end, '2026-11-02T05:00:00.000Z');
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('#whTotal')).toHaveText('0h 00m');
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(page.locator('#whTotal')).toHaveText('10h 00m');
  await page.getByRole('button', { name: 'Monthly', exact: true }).click();
  await expect(page.locator('#weeklyHours')).toBeHidden();
  await expect(page.locator('#summaryTbody')).toContainText('Morgan Lee');
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  await expect(page.locator('#whTotal')).toHaveText('10h 00m');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Monday through Sunday' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#whTotal')).toHaveText('10h 00m');
});

test('inclusive custom dates drive correction and manual-entry forms, then refresh the same breakdown', async t => {
  const page = await open(t, 390);
  await page.getByRole('button', { name: 'Set dates' }).click();
  await page.getByLabel('Custom date range', { exact: true }).check();
  await page.locator('#whDateSettings').getByLabel('From', { exact: true }).fill('2026-10-31');
  await page.getByLabel('To (inclusive)').fill('2026-10-30');
  await page.getByRole('button', { name: 'Apply dates' }).click();
  assert.equal(await page.locator('#whTo').evaluate(el => el.validity.rangeUnderflow), true);
  await page.getByLabel('To (inclusive)').fill('2026-11-01');
  await page.getByRole('button', { name: 'Apply dates' }).click();
  await expect(page.locator('#whTotal')).toHaveText('6h 00m');
  await page.getByRole('button', { name: 'Previous date range' }).click();
  await expect(page.locator('#whTotal')).toHaveText('0h 00m');
  await page.getByRole('button', { name: 'Next date range' }).click();
  await expect(page.locator('#whTotal')).toHaveText('6h 00m');
  const morgan = page.locator('[data-worker="morgan"]');
  await morgan.locator('summary').click();
  await morgan.getByRole('button', { name: 'Correct time' }).click();
  await expect(page.locator('#editOut')).toHaveValue('2026-11-01T04:00');
  await page.locator('#editOut').fill('2026-11-01T05:00');
  await page.locator('#editReason').fill('Confirmed clock-out with supervisor');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(morgan.locator('.wh-hours')).toHaveText('7h 00m');
  await expect(page.locator('#whTotal')).toHaveText('7h 00m');
  const correction = await page.evaluate(() => writes.find(call => call.name === 'admin_correct_shift_time').args);
  assert.equal(correction._expected_clock_out, '2026-11-01T09:00:00Z');
  assert.equal(correction._new_clock_out, '2026-11-01T10:00:00.000Z');
  await morgan.getByRole('button', { name: 'Add manual shift' }).click();
  await page.locator('#shiftAdminIn').fill('2026-10-31T09:00');
  await page.locator('#shiftAdminOut').fill('2026-10-31T10:00');
  await page.locator('#shiftAdminReason').fill('Missed morning punch');
  await page.locator('#shiftAdminSaveBtn').click();
  await expect(page.locator('#whTotal')).toHaveText('8h 00m');
  await expect(morgan.locator('.wh-shift')).toHaveCount(2);
  const manual = await page.evaluate(() => writes.find(call => call.name === 'admin_create_manual_shift').args);
  assert.equal(manual._clock_in, '2026-10-31T13:00:00.000Z');
  assert.equal(manual._employee_id, 'morgan');
  const alex = page.locator('[data-worker="alex"]');
  await alex.locator('summary').click();
  await alex.getByRole('button', { name: 'Close shift' }).click();
  await page.locator('#shiftAdminOutOnly').fill('2026-11-01T07:00');
  await page.locator('#shiftAdminReason').fill('Worker confirmed missed clock-out');
  await page.locator('#shiftAdminSaveBtn').click();
  await expect(alex.locator('.wh-hours')).toHaveText('2h 00m');
  await expect(page.locator('#whTotal')).toHaveText('10h 00m');
});

test('a slow earlier request cannot replace the latest period and a failed read offers retry', async t => {
  const page = await open(t);
  await page.evaluate(() => { window.holdNext = true; });
  await page.getByRole('button', { name: 'Previous week' }).click();
  await page.waitForFunction(() => !!window.releaseWeek);
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.locator('#whTotal')).toHaveText('5h 00m');
  await page.evaluate(() => releaseWeek());
  await expect(page.locator('#whRange')).toContainText('Nov 1');
  await page.evaluate(() => { window.failNext = true; });
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('#whTotal')).toHaveText('—');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#whTotal')).toHaveText('5h 00m');
});

test('another chosen starting day counts all pages and includes former workers with recorded shifts', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    const first = Date.parse('2026-10-29T13:00:00Z');
    for (let i = 0; i < 501; i++) {
      fixtureShifts.push({ id: 'minute-' + i, employee_id: 'former', worker: { display_name: 'Casey Chen' },
        clock_in: new Date(first + i * 60000).toISOString(), clock_out: new Date(first + (i + 1) * 60000).toISOString() });
    }
  });
  await page.getByRole('button', { name: 'Set dates' }).click();
  await page.getByLabel('Week starts on').selectOption('4');
  await page.getByRole('button', { name: 'Apply dates' }).click();
  await expect(page.locator('#whRange')).toContainText('Oct 29');
  await expect(page.locator('#whTotal')).toHaveText('14h 21m');
  await page.getByLabel('Search weekly workers').fill('Casey');
  await expect(page.locator('.wh-worker')).toHaveCount(1);
  await expect(page.locator('.wh-hours')).toHaveText('8h 21m');
  assert.equal(await page.evaluate(() => weekQueries.at(-1).first), 500);
});

test('shift breakdown distinguishes no break, paid minutes and the excess deducted from worker and team hours', async t => {
  const page = await open(t, 390);
  await page.evaluate(() => {
    const shift = (id, clock_in, clock_out, breaks = []) => ({ id, employee_id: 'morgan', store_id: 'airport', clock_in, clock_out, breaks });
    fixtureShifts.splice(0, fixtureShifts.length,
      shift('wed', '2026-10-29T01:31:00Z', '2026-10-29T08:05:00Z'),
      shift('sat', '2026-10-31T14:58:00Z', '2026-11-01T02:58:00Z', [
        { started_at: '2026-10-31T17:00:00Z', ended_at: '2026-10-31T17:45:00Z' },
      ]));
  });
  await page.getByRole('button', { name: 'Monday through Sunday' }).click();
  await expect(page.locator('#whTotal')).toHaveText('18h 19m');
  const worker = page.locator('[data-worker=morgan]');
  await worker.locator('summary').click();
  await expect(worker.locator('.wh-hours')).toHaveText('18h 19m');
  await expect(worker.locator('.wh-break-note')).toHaveText('No breaks recorded');
  await expect(worker.locator('.wh-break-info')).toContainText('1:00 PM EDT → 1:45 PM EDT');
  await expect(worker.locator('.wh-break-info')).toContainText('45 min · 30 min paid · 15 min unpaid');
  await expect(worker.locator('.wh-shift-hours').last()).toContainText('11h 45m');
  await expect(worker.locator('.wh-shift-hours').last()).toContainText('of 12h 00m clocked');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await worker.screenshot({ path: 'test-results/admin-shift-breaks-mobile.png' });
});

test('split shifts share the allowance for one worker and store; another store has its own allowance', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    const shift = (id, store_id, hour, minutes) => {
      const from = Date.parse('2026-11-01T00:00:00Z') + hour * 3600000;
      const iso = offset => new Date(from + offset * 60000).toISOString();
      return { id, store_id, employee_id: 'morgan', clock_in: iso(0), clock_out: iso(60),
        breaks: [{ started_at: iso(5), ended_at: iso(5 + minutes) }] };
    };
    fixtureShifts.splice(0, fixtureShifts.length, shift('1','A',8,20), shift('2','A',10,20), shift('3','B',12,30));
    return overviewApi.loadSummary();
  });
  await expect(page.locator('#whTotal')).toHaveText('2h 50m');
  await page.locator('[data-worker=morgan] summary').click();
  const breaks = page.locator('[data-worker=morgan] .wh-break-info');
  await expect(breaks.nth(0)).toContainText('20 min paid · 0 min unpaid');
  await expect(breaks.nth(1)).toContainText('10 min paid · 10 min unpaid');
  await expect(breaks.nth(2)).toContainText('30 min paid · 0 min unpaid');
});

test('a partial week respects break time already used and resets at the store’s local midnight', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    const shift = (id, clock_in, clock_out, intervals) => ({
      id, store_id: 'west', store: { timezone: 'America/Los_Angeles' }, employee_id: 'morgan', clock_in, clock_out,
      breaks: intervals.map(([started_at, ended_at]) => ({ started_at, ended_at })),
    });
    fixtureShifts.splice(0, fixtureShifts.length,
      shift('before', '2026-11-01T01:00:00Z', '2026-11-01T03:00:00Z', [['2026-11-01T02:00:00Z','2026-11-01T02:20:00Z']]),
      shift('inside', '2026-11-01T03:30:00Z', '2026-11-01T08:30:00Z', [
        ['2026-11-01T03:55:00Z','2026-11-01T04:25:00Z'], ['2026-11-01T06:50:00Z','2026-11-01T07:20:00Z'],
      ]));
    return overviewApi.loadSummary();
  });
  await expect(page.locator('#whTotal')).toHaveText('4h 00m');
  await page.locator('[data-worker=morgan] summary').click();
  await expect(page.locator('.wh-break-info li').nth(0)).toContainText('25 min in selected dates · 5 min paid · 20 min unpaid');
  await expect(page.locator('.wh-break-info li').nth(1)).toContainText('30 min in selected dates · 20 min paid · 10 min unpaid');
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('#whTotal')).toHaveText('2h 30m');
});

test('an active break is shown separately from a missing end on a closed shift', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    fixtureShifts.find(s => s.id === 'overnight').breaks = [{ started_at: '2026-11-01T07:00:00Z', ended_at: null }];
    fixtureShifts.find(s => s.id === 'open').breaks = [{ started_at: '2026-11-01T17:00:00Z', ended_at: null }];
    return overviewApi.loadSummary();
  });
  await page.locator('[data-worker=morgan] summary').click();
  await expect(page.locator('[data-worker=morgan] .wh-break-info')).toContainText('End missing');
  await page.locator('[data-worker=alex] summary').click();
  await expect(page.locator('[data-worker=alex] .wh-break-info')).toContainText('In progress');
  await expect(page.locator('[data-worker=alex] .wh-break-info')).toContainText('60 min · 30 min paid · 30 min unpaid');
  await expect(page.locator('#whTotal')).toHaveText('5h 00m');
});

test('one 45-minute break crossing midnight still counts only 30 minutes across adjacent weeks', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    fixtureShifts.splice(0, fixtureShifts.length, { id: 'night', employee_id: 'morgan',
      clock_in: '2026-11-01T03:00:00Z', clock_out: '2026-11-01T05:00:00Z',
      breaks: [{ started_at: '2026-11-01T03:40:00Z', ended_at: '2026-11-01T04:25:00Z' }] });
    return overviewApi.loadSummary();
  });
  await expect(page.locator('#whTotal')).toHaveText('0h 45m');
  await page.locator('[data-worker=morgan] summary').click();
  await expect(page.locator('.wh-break-info')).toContainText('25 min in selected dates · 10 min paid · 15 min unpaid');
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('#whTotal')).toHaveText('1h 00m');
  await expect(page.locator('.wh-break-info')).toContainText('20 min in selected dates · 20 min paid · 0 min unpaid');
});
