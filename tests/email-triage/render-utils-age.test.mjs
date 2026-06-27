import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function loadRenderUtils(now) {
  const source = readFileSync(new URL("../../email-triage.render-utils.js", import.meta.url), "utf8");
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(value) {
      return value === undefined ? new RealDate(now) : new RealDate(value);
    }

    static now() {
      return new RealDate(now).getTime();
    }
  }
  Object.setPrototypeOf(FixedDate, RealDate);
  FixedDate.UTC = RealDate.UTC;
  FixedDate.parse = RealDate.parse;
  const context = {
    window: {},
    Date: FixedDate,
    Intl,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    RegExp,
  };
  vm.runInNewContext(source, context);
  return context.window.EmailTriageRenderUtils;
}

test("compact email age switches from hours to date after 24 hours", () => {
  const utils = loadRenderUtils("2026-06-25T12:00:00-04:00");
  assert.equal(utils.formatCompactEmailAge("2026-06-24T13:00:00-04:00"), "23h");
  assert.equal(utils.formatCompactEmailAge("2026-06-24T11:00:00-04:00"), "Jun 24");
});

test("compact email age includes year for older calendar years", () => {
  const utils = loadRenderUtils("2026-06-25T12:00:00-04:00");
  assert.equal(utils.formatCompactEmailAge("2025-12-31T12:00:00-05:00"), "Dec 31, 2025");
});
