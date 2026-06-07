# Email Triage Live Regression Report

- Started:
- Finished:
- Base URL:
- Service role used for read checks: no
- Blocked send attempts: 0

## Steps

### PASSED - Open local app as authenticated admin

Evidence:

```json
{}
```

### PASSED - Mailbox canonical RPC counts match UI

Evidence:

```json
{}
```

### PASSED - Search/filter/smart folder behavior

Evidence:

```json
{}
```

### PASSED - Sync recent mailbox

Evidence:

```json
{}
```

### PASSED - Refresh Timeline

Evidence:

```json
{}
```

### PASSED - Classify unclassified

Evidence:

```json
{}
```

### PASSED - Reclassify recent 20

Evidence:

```json
{}
```

### PASSED - Backfill archive status visibility

Evidence:

```json
{}
```

### PASSED - Backfill + classify new

Evidence:

```json
{}
```

### PASSED - Backfill + reclassify all

Evidence:

```json
{}
```

### PASSED - Dashboard events/counts

Evidence:

```json
{}
```

### PASSED - Selected conversation message persistence

Evidence:

```json
{}
```

## Manual Follow-up

- Confirm no unexpected operational side effects outside Supabase read-model/audit tables.
- Confirm any changed classification counts are acceptable for the production queue.
- Confirm eBay account state in Seller Hub if a provider-side incident is suspected.
