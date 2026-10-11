# Off-site work

Workers use **My timesheet → Off-site work** during an open shift. The assignment and destination are required; expected return and instructions are optional. Outings do not deduct working time. Breaks use the existing break records and paid-break policy.

- **Back at store** requires a fresh camera photo and GPS within the shift store's radius, with accuracy of 150 m or better. It ends the outing, not the shift.
- **Finish shift off-site** requires a fresh photo, GPS, and completion note. It atomically ends the outing and shift, saves coordinates/accuracy/photo, and adds `OFFSITE_CLOCK_OUT`. Coordinates are not continuously tracked.
- Add private photos, receipts, PDFs, and notes during or after an outing. The timeline preserves the author and server timestamp. Up to eight 10 MB files can be attached per update.
- Only one outing can be active per employee. Start/end breaks separately; finish the break before returning or ending the shift. Overnight outings retain their original shift.

Admins see outings on **Admin → Overview**, including live elapsed time and the assignment. The off-site panel filters currently away, needs review, off-site clock-outs, or monthly outing history. **Mark reviewed** records an admin reason and preserves the original flag. It does not approve payroll.

**Resolve outing** handles forgotten return punches or location failures. An admin provides the actual end and reason and can choose to end the shift. This records an exception with no verified location, preserves the original shift/outing snapshot, and never invents GPS or a photo. Time corrections cannot move an outing outside its shift. Shifts with outing evidence cannot be deleted.

## Implementation and checks

`work_outings` and `work_outing_events` have employee/admin read policies; mutations go through `work_outing_action`. Admin authority comes from active employees, not user-editable JWT metadata. Request UUIDs prevent duplicate retries. Parent shift locking, bounds checks, and payroll locks protect attendance; event rows cannot be directly inserted, changed, or deleted by clients. Required photos must exist in the worker's private folder and be recent. Evidence files use the private `offsite-work-evidence` bucket; links are signed on demand.

Screens refresh while visible every minute; duration labels update every 30 seconds. Refresh is also available manually. GPS/camera access requires HTTPS and device permissions. Failed GPS does not silently complete a worker's shift; an admin can document an exception.

Apply migrations `20261011200000_offsite_work.sql` and `20261011201000_outing_clockout_filter.sql` before publishing the HTML/JS. Run:

```
node --test tests/offsite-work.test.mjs tests/time-correction.test.mjs
```

Browser checks use sample records in a local preview. Never create test punches in the production attendance database.
