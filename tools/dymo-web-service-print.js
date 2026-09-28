#!/usr/bin/env node

const fs = require("fs");
const https = require("https");
const { URLSearchParams } = require("url");

// Match DYMO's supported discovery range when "Use single port" is unchecked.
const SERVICE_HOSTS = Array.from({ length: 10 }, (_, index) => 41951 + index)
  .flatMap(port => ['127.0.0.1', 'localhost'].map(host => `https://${host}:${port}/DYMO/DLS/Printing`));

const agent = new https.Agent({ rejectUnauthorized: false });

function parseArgs(argv) {
  const args = {
    file: "",
    copies: 1,
    printer: "",
    probe: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1] || "";

    if (arg === "--file") {
      args.file = next;
      index += 1;
    } else if (arg === "--copies") {
      args.copies = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--printer") {
      args.printer = next;
      index += 1;
    } else if (arg === "--probe") {
      args.probe = true;
    }
  }

  if (!args.file && !args.probe) {
    throw new Error("Missing --file path.");
  }
  if (!Number.isFinite(args.copies) || args.copies < 1) {
    args.copies = 1;
  }
  if (args.copies > 100) {
    throw new Error(`Refusing to print more than 100 copies from one label file: ${args.copies}`);
  }

  return args;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function textFromXml(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function parsePrinters(xml) {
  const blocks = [...String(xml || "").matchAll(/<LabelWriterPrinter>([\s\S]*?)<\/LabelWriterPrinter>/gi)];

  return blocks.map((match) => {
    const block = match[1];
    return {
      name: textFromXml(block, "Name"),
      modelName: textFromXml(block, "ModelName"),
      isConnected: /^true$/i.test(textFromXml(block, "IsConnected")),
      isLocal: /^true$/i.test(textFromXml(block, "IsLocal")),
      isTwinTurbo: /^true$/i.test(textFromXml(block, "IsTwinTurbo")) || /twin\s*turbo/i.test(textFromXml(block, "ModelName") + ' ' + textFromXml(block, "Name")),
    };
  }).filter((printer) => printer.name);
}

function requestText(baseUrl, method, route, body = "", headers = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${route}`);
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      agent,
      timeout: timeoutMs,
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(text);
        } else {
          reject(new Error(`${method} ${route} returned ${response.statusCode}: ${text.slice(0, 500)}`));
        }
      });
    });

    // Bound the entire request, including DNS/TLS and a response that never ends.
    const timer = setTimeout(() => request.destroy(new Error(`${method} ${route} timed out.`)), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on("timeout", () => request.destroy(new Error(`${method} ${route} timed out.`)));
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function discoverPrinterServices(send = requestText) {
  // All probes are read-only and run together so unused ports cannot block a heartbeat.
  const results = await Promise.allSettled(SERVICE_HOSTS.map(async base => {
    const status = await send(base, 'GET', '/StatusConnected', '', {}, 3000);
    if (!/true/i.test(status)) throw new Error('Service is not ready');
    const printers = parsePrinters(await send(base, 'GET', '/GetPrinters', '', {}, 5000));
    return { base, printers };
  }));
  return results.filter(result => result.status === 'fulfilled').map(result => result.value);
}

function selectPrinterService(services, printerName) {
  const exactPrinter = service => service.printers.find(printer => printer.name === printerName && printer.isConnected)
    || service.printers.find(printer => printer.name === printerName);
  const selected = (printerName && (services.find(service => exactPrinter(service)?.isConnected)
    || services.find(service => exactPrinter(service))))
    || services.find(service => service.printers.some(printer => printer.isConnected)) || services[0];
  // Setup may see different printer lists from two installed DYMO services.
  const names = new Map();
  for (const service of services) for (const printer of service.printers) {
    if (!names.has(printer.name) || printer.isConnected) names.set(printer.name, printer);
  }
  return { base: selected?.base, printer: selected && exactPrinter(selected), printers: [...names.values()], services };
}

function createPrinterReader({ send = requestText } = {}) {
  let cachedBase;
  return async printerName => {
    if (cachedBase && printerName) {
      try {
        const printers = parsePrinters(await send(cachedBase, 'GET', '/GetPrinters', '', {}, 5000));
        const result = selectPrinterService([{ base: cachedBase, printers }], printerName);
        if (result.printer?.isConnected) return result;
      } catch { /* Rediscover if DYMO restarted, moved ports, or lost the printer. */ }
    }
    const services = await discoverPrinterServices(send);
    if (!services.length) throw new Error('DYMO web service is not reachable on ports 41951-41960. Open DYMO Connect Web Service.');
    const result = selectPrinterService(services, printerName);
    cachedBase = result.base;
    return result;
  };
}

const readPrinter = createPrinterReader();
async function firstReachableService() { return (await readPrinter('')).base; }

function choosePrinter(printers, preferredPrinterName) {
  const preferred = String(preferredPrinterName || "").trim().toLowerCase();
  if (preferred) {
    const exact = printers.find((printer) => printer.name.toLowerCase() === preferred);
    if (exact) {
      return exact;
    }

    const partial = printers.find((printer) => printer.name.toLowerCase().includes(preferred));
    if (partial) {
      return partial;
    }
  }

  return printers.find((printer) => printer.isConnected) || printers[0] || null;
}

function buildPrintParams(roll = 'default') {
  if (!['default', 'Left', 'Right'].includes(roll)) throw new Error('Invalid printer roll');
  // DYMO Connect's LabelWriterPrintParams schema. Never use Auto for different stock.
  return roll === 'default' ? '' : `<LabelWriterPrintParams><TwinTurboRoll>${roll}</TwinTurboRoll></LabelWriterPrintParams>`;
}

async function printLabel(baseUrl, printerName, labelXml, copyIndex, totalCopies, roll = 'default', send = requestText) {
  const params = new URLSearchParams();
  params.set("printerName", printerName);
  params.set("printParamsXml", buildPrintParams(roll));
  params.set("labelXml", labelXml);
  params.set("labelSetXml", "");

  await send(baseUrl, "POST", "/PrintLabel", params.toString(), {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  });

  console.log(`Printed copy ${copyIndex}/${totalCopies} on ${printerName}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const discovered = await readPrinter('');
  const printer = choosePrinter(discovered.printers, args.printer);
  const baseUrl = selectPrinterService(discovered.services, printer?.name).base;

  if (!printer) {
    throw new Error("DYMO web service is reachable, but no LabelWriter printers were returned.");
  }
  if (!printer.isConnected) {
    console.warn(`Selected DYMO printer is not marked connected by DYMO Connect: ${printer.name}`);
  }

  console.log(`DYMO web service: ${baseUrl}`);
  console.log(`DYMO printer: ${printer.name}`);

  if (args.probe) {
    console.log("DYMO print probe succeeded.");
    return;
  }

  const labelXml = fs.readFileSync(args.file, "utf8");
  for (let copy = 1; copy <= args.copies; copy += 1) {
    await printLabel(baseUrl, printer.name, labelXml, copy, args.copies);
    if (copy < args.copies) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

module.exports = { firstReachableService, requestText, parsePrinters, printLabel, readPrinter,
  discoverPrinterServices, selectPrinterService, createPrinterReader };
