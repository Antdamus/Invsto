/* Invsto print station: outbound HTTPS queue, exact local printer, durable submission journal. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const dymo = require('./dymo-web-service-print.js');
const shipping = require('./shipping-pdf-print.cjs');
const VERSION = '1.2.0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function writeDurable(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  const fd = fs.openSync(temp, 'r+');try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function protectToken(token, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('This installer currently supports Windows.');
  const script = decrypt
    ? "$s=[Console]::In.ReadToEnd() | ConvertTo-SecureString; [Console]::Write(([System.Management.Automation.PSCredential]::new('station',$s)).GetNetworkCredential().Password)"
    : "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Write(($s | ConvertFrom-SecureString))";
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: token, encoding: 'utf8', windowsHide: true }).trim();
}
function makeApi(publicConfig, config) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(publicConfig.url)) throw new Error('Invalid queue address');
  async function rpc(name, args) {
    const response = await fetch(`${publicConfig.url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: publicConfig.anonKey, Authorization: `Bearer ${publicConfig.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) { const error = new Error(data?.message || `Queue request failed (${response.status})`);error.code = data?.code;throw error; }
    return data;
  }
  return {
    pair: args => rpc('pair_print_station', args),
    poll: (connected, error) => rpc('poll_print_station', { _station_id: config.stationId, _token: config.token, _connected: connected, _error: error || '', _version: VERSION }),
    report: (job, status, submitted, detail = '') => rpc('report_label_print', { _station_id: config.stationId, _token: config.token, _job_id: job.id, _claim_token: job.claim_token, _status: status, _submitted: submitted, _detail: detail }),
  };
}
function validateJob(job, printerName, isTwinTurbo = false) {
  if (!job?.id || !job.claim_token || !Number.isInteger(job.copies) || job.copies < 1 || job.copies > 100) throw new Error('Invalid print job');
  if (job.printer_name !== printerName) throw new Error('This job targets a different printer. It was not rerouted.');
  const roll = job.printer_roll ?? 'default';
  if (!['default', 'Left', 'Right'].includes(roll)) throw new Error('Invalid printer roll');
  if (roll !== 'default' && !isTwinTurbo) throw new Error('Left/right roll selection requires a Twin Turbo printer.');
  if (job.document_type === 'pdf') {
    if (roll !== 'default' || !shipping.isShippingPrinter(printerName, job.printer_model)) throw new Error('Shipping PDFs require the selected 5XL printer.');
    if (!Number.isInteger(job.pdf_page_count) || job.pdf_page_count < 1 || job.pdf_page_count > 100 || job.copies * job.pdf_page_count > 100) throw new Error('A request can contain up to 100 shipping labels.');
    return;
  }
  if (job.document_type && job.document_type !== 'dymo') throw new Error('Unsupported print document');
  if (typeof job.label_xml !== 'string' || Buffer.byteLength(job.label_xml) > 2000000 || !/<(DesktopLabel|DieCutLabel|ContinuousLabel)[ >]/.test(job.label_xml) || /<!(DOCTYPE|ENTITY)/i.test(job.label_xml)) throw new Error('Invalid DYMO label');
}
async function processPrintJob(job, { api, printerName, isTwinTurbo = false, print, save, prepare = async () => null, pause = sleep }) {
  const entry = { job, submitted: 0, status: 'working', inflight: false, detail: '' };
  save(entry);
  let prepared;
  try {
    validateJob(job, printerName, isTwinTurbo);
    prepared = await prepare(job);
    for (let copy = 0; copy < job.copies; copy++) {
      // The server must still own the claim immediately before every physical submission.
      const gate = await api.report(job, 'claimed', entry.submitted);
      if (gate?.status !== 'claimed') throw new Error('This print request is no longer active');
      entry.inflight = true;save(entry);
      await print(job.label_xml, copy + 1, job.copies, job.printer_roll ?? 'default', prepared);
      entry.submitted++;entry.inflight = false;save(entry);
      if (copy + 1 < job.copies) await pause(500);
    }
    entry.status = 'submitted';entry.detail = job.document_type === 'pdf' ? 'Windows accepted the shipping PDF copies. Check the printer for the physical labels.' : 'DYMO accepted every copy. Check the printer for the physical labels.';
  } catch (error) {
    entry.status = entry.inflight || entry.submitted > 0 ? 'uncertain' : 'failed';
    entry.detail = `${error.message || 'Printing stopped'}. ${entry.submitted} copies confirmed submitted. Check the printer before retrying.`;
  }
  try { prepared?.cleanup?.(); } catch {}
  save(entry);
  // If this response is lost, recovery repeats only the acknowledgement, never the print.
  await api.report(job, entry.status, entry.submitted, entry.detail);
  save(null);
  return entry;
}
async function recoverPrintJob(entry, { api, save }) {
  if (!entry) return;
  const status = entry.status === 'working' ? 'uncertain' : entry.status;
  const detail = entry.status === 'working' ? 'Helper restarted during a print job. Check the printer before requesting another copy.' : entry.detail;
  await api.report(entry.job, status, entry.submitted, detail);
  save(null);
}
async function readPrinter(printerName) {
  return dymo.readPrinter(printerName);
}
function printerConnectionError(local, printerName) {
  if (local.printer?.isConnected) return '';
  const connected = local.printers.filter(printer => printer.isConnected).map(printer => printer.name);
  if (!local.printer) return `DYMO's web service cannot find the paired printer "${printerName}". ${connected.length ? 'Connected: ' + connected.join(', ') + '. ' : ''}Run Diagnose Invsto Printer on this computer.`;
  return `DYMO's web service reports "${printerName}" disconnected (port ${new URL(local.base).port}). If DYMO Connect can print, run Diagnose Invsto Printer on this computer.`;
}
async function diagnose(dataDir, { discover = dymo.discoverPrinterServices, output = console.log } = {}) {
  // Read only the saved printer name. Never decrypt a token, contact the queue, or print.
  const config = readJson(path.join(dataDir, 'station.json'), null);
  output(`INVSTO PRINTER DIAGNOSTIC ${VERSION}\nNo labels will be sent by this diagnostic.\nPaired printer: ${config?.printerName || '(not paired)'}`);
  const services = await discover();
  if (!services.length) output('No DYMO web service answered on ports 41951-41960. Open DYMO Connect Web Service.');
  for (const service of services) {
    output(`\nService: ${service.base}`);
    if (!service.printers.length) output('  No LabelWriter printers returned.');
    for (const printer of service.printers) output(`  ${printer.name} | ${printer.isConnected ? 'CONNECTED' : 'DISCONNECTED'} | ${printer.isLocal ? 'local' : 'not local'}${printer.name === config?.printerName ? ' | PAIRED PRINTER' : ''}`);
  }
  if (services.length && config?.printerName) {
    const local = dymo.selectPrinterService(services, config.printerName);
    output('\n' + (printerConnectionError(local, config.printerName) || `Ready: paired printer found on port ${new URL(local.base).port}.`));
  }
  output('\nYou can share this diagnostic text; it contains no pairing credentials.');
}
async function setup(dataDir, publicConfig, root = dataDir) {
  if (readJson(path.join(dataDir, 'active-job.json'), null)) throw new Error('The previous station has an unconfirmed print result. Start the existing helper while online so it can report that result before pairing again.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nINVSTO PRINT STATION\nOpen Print stations in Invsto on your phone, add this computer, then enter its pairing code here.\n');
    let printers = [];
    try { ({printers} = await readPrinter('')); } catch {}
    try {
      for (const row of await shipping.windowsPrinters()) {
        if (!shipping.isShippingPrinter(row.Name,row.DriverName)) continue;
        const printer = {name:row.Name,modelName:row.DriverName,isConnected:!row.WorkOffline&&Number(row.PrinterStatus)!==7,isTwinTurbo:false};
        const index = printers.findIndex(entry=>entry.name===row.Name);
        if(index>=0)printers[index]=printer;else printers.push(printer);
      }
    } catch {}
    if (!printers.length) throw new Error('No DYMO LabelWriter is installed. Install DYMO Connect and your printer, then run setup again.');
    printers.sort((a, b) => Number(b.isConnected) - Number(a.isConnected));
    printers.forEach((printer, index) => console.log(`${index + 1}. ${printer.name} (${printer.isConnected ? 'CONNECTED' : 'currently disconnected'})`));
    const answer = printers.length === 1 ? '1' : await rl.question('Printer number: ');
    const printer = printers[Number(answer.trim()) - 1];
    if (!printer) throw new Error('Choose a listed printer number.');
    const existing = profileDirectories(root).map(dir => readJson(path.join(dir, 'station.json'), null)).find(config => config?.printerName === printer.name && !fs.existsSync(path.join(dataDir, 'station.json')));
    if (existing) throw new Error(`This printer is already paired as ${existing.name}. Use that station, or choose another printer.`);
    const code = (await rl.question('Pairing code from Invsto: ')).trim();
    const pendingFile = path.join(dataDir, 'pairing.json');
    // Persist before pairing so a lost response can be retried with the same device credential.
    let pending = readJson(pendingFile, null);
    const codeHash = crypto.createHash('sha256').update(code.replace(/[^a-z0-9]/gi, '').toUpperCase()).digest('hex');
    if (!pending || pending.codeHash !== codeHash) {
      pending = { codeHash, protectedToken: protectToken(crypto.randomBytes(32).toString('hex')) };
      writeDurable(pendingFile, pending);
    }
    const token = protectToken(pending.protectedToken, true);
    const paired = await makeApi(publicConfig, {}).pair({ _code: code, _token: token, _computer: os.hostname(), _printer: printer.name, _model: printer.modelName });
    writeDurable(path.join(dataDir, 'station.json'), { stationId: paired.station_id, name: paired.name, printerName: printer.name, printerModel: printer.modelName, protectedToken: pending.protectedToken });
    fs.unlinkSync(pendingFile);
    console.log(`\nPaired: ${paired.name}\nPrinter: ${printer.name}\n${printer.isConnected ? 'Ready to receive labels.' : 'Connect and turn on the printer. Labels will wait until it is connected.'}`);
  } finally { rl.close(); }
}
function acquireLock(dataDir) {
  const lockFile = path.join(dataDir, 'agent.lock');
  const prior = readJson(lockFile, null);
  if (prior?.pid) {
    try { process.kill(prior.pid, 0);throw new Error('The print helper is already running.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lockFile);
  }
  const fd = fs.openSync(lockFile, 'wx');fs.writeFileSync(fd, JSON.stringify({pid: process.pid}));fs.closeSync(fd);
  return () => { try { fs.unlinkSync(lockFile); } catch {} };
}
async function run(dataDir, publicConfig, root = dataDir) {
  const unlock = acquireLock(dataDir);
  process.on('exit', unlock);
  const config = readJson(path.join(dataDir, 'station.json'), null);
  if (!config) throw new Error('Run setup to pair this computer first.');
  config.token = protectToken(config.protectedToken, true);
  const api = makeApi(publicConfig, config);
  const shippingStation = shipping.isShippingPrinter(config.printerName, config.printerModel);
  const journal = path.join(dataDir, 'active-job.json');
  const save = entry => writeDurable(journal, entry);
  const logPath = path.join(dataDir, 'print-station.log');
  const log = text => {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2000000) fs.renameSync(logPath, logPath + '.previous');
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);
  };
  const stopFile = path.join(dataDir, 'stop.request');
  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
  log(`Started ${VERSION}: ${config.name} / ${config.printerName}`);
  let lastError = '';
  while (!fs.existsSync(stopFile)) {
    try {
      const outstanding = readJson(journal, null);
      if (outstanding) await recoverPrintJob(outstanding, { api, save });
      let local, error = '', connected = false;
      try {
        if (shippingStation) {
          shipping.enginePath(root);
          const windows = await shipping.printerState(config.printerName);
          connected = windows.connected;error = windows.error;
        } else {
          local = await readPrinter(config.printerName);error = printerConnectionError(local, config.printerName);
          connected = Boolean(local?.printer?.isConnected);
        }
      } catch (failure) { error = failure.message || 'Printer unavailable. Run Diagnose Invsto Printer.'; }
      const job = await api.poll(connected, error);
      if (job) {
        const result = await processPrintJob(job, { api, printerName: config.printerName, isTwinTurbo: local?.printer?.isTwinTurbo, save,
          prepare: job => job.document_type === 'pdf' ? shipping.prepareJob(job, dataDir, root) : null,
          print: async (xml, copy, copies, roll, prepared) => {
            if (job.document_type === 'pdf') return shipping.printPrepared(prepared, config.printerName);
            const fresh = await readPrinter(config.printerName);
            if (!fresh.printer?.isConnected) throw new Error('Selected printer disconnected');
            if (roll !== 'default' && !fresh.printer.isTwinTurbo) throw new Error('Selected printer no longer supports two rolls');
            await dymo.printLabel(fresh.base, config.printerName, xml, copy, copies, roll);
          } });
        log(`${job.id}: ${result.status}, ${result.submitted}/${job.copies}`);
      }
      lastError = '';
    } catch (error) {
      if (error.message !== lastError) { log(error.message);lastError = error.message; }
      if (error.code === '42501') { log('Station access was removed. Stopping.');break; }
    }
    await sleep(5000);
  }
}
function profileDirectories(root) {
  const profiles = path.join(root, 'profiles');
  const extra = fs.existsSync(profiles) ? fs.readdirSync(profiles, {withFileTypes:true})
    .filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
    .map(entry => path.join(profiles, entry.name)) : [];
  return [root, ...extra];
}
function profileDirectory(root, id) {
  if (!id) return root;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid printer profile');
  return path.join(root, 'profiles', id);
}
function backgroundProfile(root, directory) {
  if (!readJson(path.join(directory, 'station.json'), null)) return;
  const lock = readJson(path.join(directory, 'agent.lock'), null);
  if (lock?.pid) {try {process.kill(lock.pid, 0);return;} catch(error) {if(error.code !== 'ESRCH') throw error;}}
  const args = [__filename, '--run'];
  if (directory !== root) args.push('--profile', path.basename(directory));
  const child = spawn(process.execPath, args, {detached:true,stdio:'ignore',windowsHide:true});child.unref();
}
async function main() {
  const root = process.env.INVSTO_PRINT_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'InvstoPrintStation');
  const profileIndex = process.argv.indexOf('--profile');
  if (profileIndex >= 0 && !process.argv[profileIndex+1]) throw new Error('Missing printer profile');
  let dataDir = profileDirectory(root, profileIndex >= 0 ? process.argv[profileIndex+1] : null);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.argv.includes('--diagnose')) {
    for (const dir of profileDirectories(root)) {
      await diagnose(dir);
      const config = readJson(path.join(dir,'station.json'),null);
      if (config && shipping.isShippingPrinter(config.printerName,config.printerModel)) {
        try {shipping.enginePath(root);console.log('Shipping PDF engine verified.');console.log(await shipping.printerState(config.printerName));}
        catch(error){console.log(error.message);}
      }
    }
    return;
  }
  if (process.argv.includes('--stop')) {for(const dir of profileDirectories(root)) fs.writeFileSync(path.join(dir,'stop.request'),'stop');return;}
  const publicConfig = readJson(path.join(__dirname, 'station-public-config.json'), null);
  if (!publicConfig) throw new Error('The station public configuration is missing. Download the complete setup package.');
  if (process.argv.includes('--background') || process.argv.includes('--run-all')) {
    for(const dir of profileDirectories(root)) backgroundProfile(root,dir);
    return;
  }
  if (process.argv.includes('--add-printer')) {
    // Reuse an incomplete profile so interrupted pairing retains its original credential.
    dataDir = profileDirectories(root).slice(1).find(dir=>!fs.existsSync(path.join(dir,'station.json'))) || profileDirectory(root,crypto.randomUUID());
    fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
    return setup(dataDir,publicConfig,root);
  }
  if (process.argv.includes('--setup')) return setup(dataDir, publicConfig, root);
  return run(dataDir, publicConfig, root);
}
if (require.main === module) main().catch(error => { console.error(error.message);process.exitCode = 1; });
module.exports = { processPrintJob, recoverPrintJob, validateJob, writeDurable, acquireLock, makeApi, diagnose, printerConnectionError, profileDirectories, profileDirectory };
