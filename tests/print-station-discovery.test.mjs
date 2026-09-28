import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile, readFile, unlink, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require = createRequire(import.meta.url);
const dymo = require('../tools/dymo-web-service-print.js');
const {diagnose, printerConnectionError} = require('../tools/print-station-agent.cjs');
const name = 'DYMO LabelWriter 450 Twin Turbo';
const base = port => `https://127.0.0.1:${port}/DYMO/DLS/Printing`;
const xml = (printerName = name, connected = true) => `<Printers><LabelWriterPrinter><Name>${printerName}</Name><ModelName>${name}</ModelName><IsConnected>${connected}</IsConnected><IsLocal>True</IsLocal></LabelWriterPrinter></Printers>`;
function fakeServices(entries) {
  const calls = [];
  const send = async (url, method, route, body, headers, timeout) => {
    calls.push({url, method, route, timeout});
    assert.equal(method, 'GET', 'Discovery must never print');
    assert.match(url, /^https:\/\/(127\.0\.0\.1|localhost):419(5[1-9]|60)\/DYMO\/DLS\/Printing$/);
    if (!entries.has(url)) throw new Error('ECONNREFUSED');
    if (route === '/StatusConnected') return 'true';
    assert.equal(route, '/GetPrinters');
    return entries.get(url);
  };
  return {send, calls};
}

test('discovers the connected exact printer on the last supported port despite a stale service on 41951', async () => {
  const {send, calls} = fakeServices(new Map([[base(41951), xml(name, false)], [base(41960), xml()]]));
  const result = await dymo.createPrinterReader({send})(name);
  assert.equal(result.base, base(41960));
  assert.equal(result.printer.name, name);
  assert.equal(result.printer.isConnected, true);
  assert.equal(calls.filter(call => call.route === '/StatusConnected').length, 20);
  assert.ok(calls.every(call => call.timeout > 0 && call.timeout <= 5000));
});

test('uses a fresh cached printer read, then rediscovers when DYMO changes ports', async () => {
  const entries = new Map([[base(41952), xml()]]);
  const {send, calls} = fakeServices(entries);
  const read = dymo.createPrinterReader({send});
  await read(name); calls.length = 0;
  await read(name);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/GetPrinters');
  entries.delete(base(41952)); entries.set(base(41959), xml());
  assert.equal((await read(name)).base, base(41959));
  entries.set(base(41959), xml(name, false));
  assert.equal((await read(name)).printer.isConnected, false, 'A cached connected status is never reused');
});

test('never substitutes Copy 1 or an unrelated connected printer for the paired name', async () => {
  const {send} = fakeServices(new Map([[base(41951), xml(name, false)], [base(41952), xml(name + ' (Copy 1)')]]));
  const local = await dymo.createPrinterReader({send})(name);
  assert.equal(local.printer.name, name);
  assert.equal(local.printer.isConnected, false);
  assert.match(printerConnectionError(local, name), /reports.*disconnected.*41951/);
  const missing = await dymo.createPrinterReader({send})('Removed printer');
  assert.equal(missing.printer, undefined);
  assert.match(printerConnectionError(missing, 'Removed printer'), /cannot find the paired printer/);
});

test('supports localhost-only DYMO service and tolerates malformed/unavailable peers', async () => {
  const url = 'https://localhost:41957/DYMO/DLS/Printing';
  const {send} = fakeServices(new Map([[url, xml()], [base(41951), 'no printers']]));
  const local = await dymo.createPrinterReader({send})(name);
  assert.equal(local.base, url);
  assert.equal(local.printer.isConnected, true);
  const unavailable = fakeServices(new Map());
  await assert.rejects(dymo.createPrinterReader({send: unavailable.send})(name), /not reachable on ports 41951-41960/);
});

test('setup lists each exact printer once and uses the connected record for duplicate service entries', async () => {
  const disconnected = {name, isConnected: false};
  const connected = {name, isConnected: true};
  const local = dymo.selectPrinterService([
    {base: base(41951), printers: [disconnected]},
    {base: base(41952), printers: [disconnected, connected, {name: name + ' (Copy 1)', isConnected: false}]},
  ], name);
  assert.equal(local.printer, connected);
  assert.equal(local.base, base(41952));
  assert.equal(local.printers.length, 2);
  assert.equal(local.printers.find(printer => printer.name === name).isConnected, true);
});

test('diagnostic shows service/printer states without decrypting credentials or touching pending work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invsto-print-diagnostic-'));
  const stationPath = join(directory, 'station.json');
  const journalPath = join(directory, 'active-job.json');
  const station = JSON.stringify({printerName: name, protectedToken: 'SECRET-DO-NOT-DECRYPT', stationId: 'PRIVATE-STATION-ID'});
  const journal = JSON.stringify({status: 'working', job: {id: 'PRIVATE-JOB-ID'}});
  try {
    await writeFile(stationPath, station); await writeFile(journalPath, journal);
    const lines = [];
    await diagnose(directory, {output: line => lines.push(line), discover: async () => [
      {base: base(41951), printers: [{name, isConnected: false}]},
      {base: base(41958), printers: [{name, isConnected: true, isLocal: true}]},
    ]});
    const text = lines.join('\n');
    assert.match(text, /1\.1\.1/);
    assert.match(text, /DISCONNECTED/);
    assert.match(text, /CONNECTED \| local \| PAIRED PRINTER/);
    assert.match(text, /Ready: paired printer found on port 41958/);
    assert.doesNotMatch(text, /SECRET|PRIVATE|protectedToken/);
    assert.equal(await readFile(stationPath, 'utf8'), station);
    assert.equal(await readFile(journalPath, 'utf8'), journal);
  } finally {
    await unlink(stationPath); await unlink(journalPath); await rmdir(directory);
  }
});
