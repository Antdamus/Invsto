#!/usr/bin/env node

const fs = require("fs");
const https = require("https");
const { URLSearchParams } = require("url");

const SERVICE_HOSTS = [
  "https://localhost:41951/DYMO/DLS/Printing",
  "https://127.0.0.1:41951/DYMO/DLS/Printing",
];

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
    };
  }).filter((printer) => printer.name);
}

function requestText(baseUrl, method, route, body = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${route}`);
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      agent,
      timeout: 12000,
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

    request.on("timeout", () => {
      request.destroy(new Error(`${method} ${route} timed out.`));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function firstReachableService() {
  const errors = [];

  for (const baseUrl of SERVICE_HOSTS) {
    try {
      const status = await requestText(baseUrl, "GET", "/StatusConnected");
      if (/true/i.test(status)) {
        return baseUrl;
      }
      errors.push(`${baseUrl}: StatusConnected returned ${status}`);
    } catch (error) {
      errors.push(`${baseUrl}: ${error.message}`);
    }
  }

  throw new Error(`DYMO web service is not reachable. ${errors.join(" | ")}`);
}

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

async function printLabel(baseUrl, printerName, labelXml, copyIndex, totalCopies) {
  const params = new URLSearchParams();
  params.set("printerName", printerName);
  params.set("printParamsXml", "");
  params.set("labelXml", labelXml);
  params.set("labelSetXml", "");

  await requestText(baseUrl, "POST", "/PrintLabel", params.toString(), {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  });

  console.log(`Printed copy ${copyIndex}/${totalCopies} on ${printerName}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = await firstReachableService();
  const printersXml = await requestText(baseUrl, "GET", "/GetPrinters");
  const printers = parsePrinters(printersXml);
  const printer = choosePrinter(printers, args.printer);

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

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
