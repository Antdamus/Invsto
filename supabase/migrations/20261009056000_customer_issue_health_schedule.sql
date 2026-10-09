begin;
select cron.schedule('invsto-customer-issue-sync-health','*/5 * * * *','select public.check_customer_issue_sync();');
commit;
