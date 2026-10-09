begin;
select cron.schedule('invsto-customer-issue-deadlines','*/5 * * * *','select public.enqueue_customer_issue_deadlines();');
commit;
