# Step 5F.6R Label and Read-State Stabilization

## Label Model

AI classification labels are model-generated and live under `AI Classification` in the conversation detail panel:

- Topics
- Buyer flags
- Risk flags
- Priority
- Response status

System labels are deterministic and live under `System Labels`:

- Source: `Member Message` or `Platform Notification`
- Unread state: `Unread` or `Read`
- Context labels: `Has Order`, `Has Return`, `Has Media`, `Has Listing`
- Status labels such as `Active`
- Review labels such as `Needs Review` or `Needs Reclassification`
- Warning explanation rows sourced from deterministic context warnings

Preview cards intentionally show only priority, main topic, strongest buyer type, and unread state. Full label inspection belongs in the detail panel.

## Smart Folder Rules

Smart folders must expose their active rules in the folder rail and in the selected-folder filter strip. Built-in source folders use deterministic source state. The `Returns` folder is intentionally aligned to the AI topic `return`; deterministic return-case links remain available through the separate `Has return` folder.

## Read State Model

Current state:

- `Unread` and `Read` are system state, not AI labels.
- OG displays read state from canonical eBay conversation metadata (`unread_count`) and message metadata (`read_status`, `is_read`) when available.
- OG does not currently mutate eBay read state.

Future 5F.6P live sync model:

- Read in OG -> Read in eBay: operator read actions in OG should enqueue an explicit read-state mutation/audit step before calling any eBay provider mutation.
- Read in eBay -> Read in OG: live sync should pull eBay read state and update OG deterministic state without invoking AI reclassification.
- Conflict handling should prefer the newest provider-observed state unless an OG operator action is pending provider confirmation.

No AI classification run should create or modify unread/read labels.
