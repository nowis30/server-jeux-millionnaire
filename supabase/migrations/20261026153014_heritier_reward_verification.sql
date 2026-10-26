-- Private, server-managed receipts. A client callback alone cannot mark an ad verified.
create table if not exists heritier.reward_intents (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references heritier.players(id) on delete cascade,
  game_id uuid not null references heritier.games(id) on delete cascade,
  kind text not null check (kind in ('quiz-token', 'pari-token', 'quiz-reveal', 'bonus')),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  verified_at timestamptz,
  consumed_at timestamptz,
  ad_transaction_id text unique,
  check (consumed_at is null or verified_at is not null),
  check ((verified_at is null) = (ad_transaction_id is null))
);
create index if not exists reward_intents_player_created_idx on heritier.reward_intents(player_id, created_at);
alter table heritier.reward_intents enable row level security;
revoke all on heritier.reward_intents from public, anon, authenticated;
comment on table heritier.reward_intents is 'AdMob SSV receipts: verified by signature, consumed within the same transaction as the reward.';
