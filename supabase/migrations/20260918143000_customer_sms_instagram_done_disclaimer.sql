-- Update the DONE auto-reply with Instagram verification and disqualification terms.

insert into public.customer_sms_auto_messages (
  message_key,
  title,
  description,
  body,
  fallback_body
)
values (
  'instagram_done',
  'Instagram DONE reply',
  'Sent after the customer replies DONE after following Instagram.',
  $sms$OG Jewelers: You're officially entered for our daily $100 Zelle giveaways. Good luck!

Instagram verification rule: if you are selected as a winner and were not following @OGJewelers before the winning draw, you will be disqualified and the prize will go to another eligible user.

If you win, you must provide your Instagram username so we can message you there and verify the follow.$sms$,
  $sms$OG Jewelers: You're officially entered for our daily $100 Zelle giveaways. Good luck!

Instagram verification rule: if you are selected as a winner and were not following @OGJewelers before the winning draw, you will be disqualified and the prize will go to another eligible user.

If you win, you must provide your Instagram username so we can message you there and verify the follow.$sms$
)
on conflict (message_key) do update
set
  title = excluded.title,
  description = excluded.description,
  body = excluded.body,
  fallback_body = excluded.fallback_body;

notify pgrst, 'reload schema';
