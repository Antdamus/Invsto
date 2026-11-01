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
        select() { return this; }, order() { return this; },
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
  assert.deepEqual((await page.evaluate(() => weekQueries.at(-1))).start, '2026-10-26T04:00:00.000Z');
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
