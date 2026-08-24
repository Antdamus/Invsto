import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const teamTasksHtml = readFileSync(new URL("../team-tasks.html", import.meta.url), "utf8");
const teamTasksJs = readFileSync(new URL("../team-tasks.js", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../supabase/migrations/20260823134500_task_notification_direct_task_links.sql", import.meta.url),
  "utf8",
);

test("task notification links open the unified task page", () => {
  assert.match(teamTasksHtml, /team-tasks\.js\?v=chat-focused-task-20260824/);
  assert.match(
    teamTasksJs,
    /function getTaskNotificationHref\(notification = \{\}\) \{\s*return `team-tasks\.html\?taskId=\$\{encodeURIComponent\(notification\.task_id \|\| ""\)\}`;\s*\}/,
  );
  assert.match(migration, /select 'team-tasks\.html\?taskId=' \|\| coalesce\(_task_id::text, ''\)/);
});

test("direct task links show only the requested task", () => {
  assert.match(teamTasksHtml, /team-tasks\.css\?v=chat-focused-task-20260824/);
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
