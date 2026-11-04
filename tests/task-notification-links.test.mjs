import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const teamTasksHtml = readFileSync(new URL("../team-tasks.html", import.meta.url), "utf8");
const teamTasksJs = readFileSync(new URL("../team-tasks.js", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../supabase/migrations/20260823134500_task_notification_direct_task_links.sql", import.meta.url),
  "utf8",
);

test("task notification links open the unified task page", () => {
  assert.match(teamTasksHtml, /src="team-tasks\.js\?v=[^"]+"/);
  const source=teamTasksJs.slice(teamTasksJs.indexOf("function getTaskNotificationHref("),teamTasksJs.indexOf("function getTaskNotificationTypeLabel("));
  const href=runInNewContext(source+";getTaskNotificationHref",{window:{OGTaskNotifications:{href:()=>"return-link"}}});
  assert.equal(href({task_id:"a/b",metadata:{open_url:"https://unexpected.example"}}),"team-tasks.html?taskId=a%2Fb");
  assert.equal(href({notification_type:"refund_reminder"}),"return-link");
  assert.match(migration, /select 'team-tasks\.html\?taskId=' \|\| coalesce\(_task_id::text, ''\)/);
});

test("direct task links show only the requested task", () => {
  assert.match(teamTasksHtml, /team-tasks\.css\?v=workspace-20261007/);
  assert.match(teamTasksJs, /const requested = getRequestedTaskId\(\);\s*if \(requested\) \{\s*const focusedTask = tasks\.find\(\(task\) => task\.id === requested\);\s*if \(focusedTask\) return \[focusedTask\];\s*\}/);
  assert.match(teamTasksJs, /task\.id === getRequestedTaskId\(\) \? "is-direct-focus" : ""/);
});

test("task SMS notifications include a tappable direct task URL", () => {
  assert.match(migration, /create or replace function public\.task_notification_sms_app_base_url\(\)/);
  assert.match(migration, /https:\/\/antdamus\.github\.io\/Invsto/);
  assert.match(migration, /v_link_suffix := ' Open: ' \|\| v_open_url;/);
  assert.match(migration, /public\.task_notification_app_path\(new\.source, new\.task_id\)/);
  assert.match(migration, /'open_url', v_open_url/);
  assert.match(migration, /left\(regexp_replace\(v_body, '\\s\+', ' ', 'g'\), 480\)/);
});
