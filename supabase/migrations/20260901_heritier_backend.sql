-- Héritier Millionnaire — backend Supabase privé.
-- Le navigateur n'accède jamais directement à ce schéma; seule l'Edge Function
-- se connecte à Postgres après validation de l'identité Supabase Auth.

create schema if not exists heritier;

create table if not exists heritier.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists heritier.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'running' check (status in ('lobby', 'running', 'ended')),
  base_mortgage_rate numeric(8,6) not null default 0.05,
  appreciation_annual numeric(8,6) not null default 0.03,
  inflation_annual numeric(8,6) not null default 0.02,
  inflation_index numeric(18,8) not null default 1,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists heritier.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references heritier.games(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null,
  cash numeric(18,2) not null default 1000000,
  net_worth numeric(18,2) not null default 1000000,
  cumulative_pari_gain numeric(18,2) not null default 0,
  cumulative_quiz_gain numeric(18,2) not null default 0,
  cumulative_market_realized numeric(18,2) not null default 0,
  cumulative_market_dividends numeric(18,2) not null default 0,
  quiz_tokens integer not null default 15 check (quiz_tokens between 0 and 20),
  quiz_tokens_updated_at timestamptz not null default now(),
  pari_tokens integer not null default 20 check (pari_tokens between 0 and 100),
  pari_tokens_updated_at timestamptz not null default now(),
  last_ad_pari_at timestamptz,
  last_ad_quiz_at timestamptz,
  last_bonus_at timestamptz,
  drag_stage integer not null default 1,
  drag_last_reward_at timestamptz,
  drag_last_run_at timestamptz,
  drag_best_time_ms integer,
  drag_engine_level integer not null default 1,
  drag_transmission_level integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, auth_user_id)
);
create unique index if not exists players_game_nickname_ci_idx
  on heritier.players (game_id, lower(nickname));
create index if not exists players_game_net_worth_idx
  on heritier.players (game_id, net_worth desc);

create table if not exists heritier.property_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  price numeric(18,2) not null check (price > 0),
  base_rent numeric(18,2) not null check (base_rent >= 0),
  taxes numeric(18,2) not null default 0,
  insurance numeric(18,2) not null default 0,
  maintenance numeric(18,2) not null default 0,
  units integer not null default 1 check (units > 0),
  city text not null,
  address text not null default '',
  province text not null default 'Québec',
  postal_code text not null default '',
  year_built integer not null default 2000,
  surface_area numeric(12,2) not null default 100,
  land_area numeric(12,2) not null default 300,
  image_url text,
  plumbing_state text not null default 'bon',
  electricity_state text not null default 'bon',
  roof_state text not null default 'bon',
  windows_state text not null default 'bon',
  foundation_state text not null default 'bon',
  interior_state text not null default 'bon',
  exterior_state text not null default 'bon',
  floors integer not null default 1,
  has_commercial_center boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists heritier.property_holdings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references heritier.games(id) on delete cascade,
  player_id uuid not null references heritier.players(id) on delete cascade,
  template_id uuid not null references heritier.property_templates(id),
  purchase_price numeric(18,2) not null,
  down_payment numeric(18,2) not null default 0,
  initial_mortgage_debt numeric(18,2) not null default 0,
  current_value numeric(18,2) not null,
  current_rent numeric(18,2) not null,
  mortgage_rate numeric(8,6) not null default 0.05,
  mortgage_debt numeric(18,2) not null default 0,
  weekly_payment numeric(18,2) not null default 0,
  weeks_elapsed integer not null default 0,
  term_years integer not null default 25,
  accumulated_rent numeric(18,2) not null default 0,
  accumulated_interest_paid numeric(18,2) not null default 0,
  accumulated_taxes_paid numeric(18,2) not null default 0,
  accumulated_insurance_paid numeric(18,2) not null default 0,
  accumulated_maintenance_paid numeric(18,2) not null default 0,
  accumulated_net_cashflow numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, template_id)
);
create index if not exists property_holdings_player_idx
  on heritier.property_holdings (game_id, player_id);

create table if not exists heritier.repair_events (
  id uuid primary key default gen_random_uuid(),
  holding_id uuid not null references heritier.property_holdings(id) on delete cascade,
  type text not null,
  cost numeric(18,2) not null,
  impact text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists heritier.refinance_logs (
  id uuid primary key default gen_random_uuid(),
  holding_id uuid not null references heritier.property_holdings(id) on delete cascade,
  amount numeric(18,2) not null,
  rate numeric(8,6) not null,
  at timestamptz not null default now()
);

create table if not exists heritier.listings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references heritier.games(id) on delete cascade,
  holding_id uuid not null references heritier.property_holdings(id) on delete cascade,
  template_id uuid not null references heritier.property_templates(id),
  seller_id uuid not null references heritier.players(id) on delete cascade,
  price numeric(18,2) not null check (price > 0),
  type text not null default 'fixed' check (type in ('fixed', 'auction')),
  created_at timestamptz not null default now(),
  unique (holding_id)
);
create index if not exists listings_game_created_idx
  on heritier.listings (game_id, created_at desc);

create table if not exists heritier.market_holdings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references heritier.games(id) on delete cascade,
  player_id uuid not null references heritier.players(id) on delete cascade,
  symbol text not null check (symbol in ('SP500', 'QQQ', 'TSX', 'GLD', 'TLT')),
  quantity numeric(18,6) not null check (quantity > 0),
  avg_price numeric(18,6) not null check (avg_price > 0),
  unique (game_id, player_id, symbol)
);

create table if not exists heritier.market_ticks (
  id bigint generated always as identity primary key,
  game_id uuid not null references heritier.games(id) on delete cascade,
  symbol text not null check (symbol in ('SP500', 'QQQ', 'TSX', 'GLD', 'TLT')),
  price numeric(18,6) not null check (price > 0),
  at timestamptz not null default now()
);
create index if not exists market_ticks_latest_idx
  on heritier.market_ticks (game_id, symbol, at desc);

create table if not exists heritier.dividend_logs (
  id bigint generated always as identity primary key,
  game_id uuid not null references heritier.games(id) on delete cascade,
  player_id uuid not null references heritier.players(id) on delete cascade,
  symbol text not null,
  amount numeric(18,2) not null,
  at timestamptz not null default now()
);
create index if not exists dividend_logs_player_at_idx
  on heritier.dividend_logs (game_id, player_id, at desc);

create table if not exists heritier.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  question text not null unique,
  option_a text not null,
  option_b text not null,
  option_c text not null,
  option_d text not null,
  correct_answer text not null check (correct_answer in ('A', 'B', 'C', 'D')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  category text not null,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists quiz_questions_pool_idx
  on heritier.quiz_questions (active, difficulty, category);

create table if not exists heritier.quiz_question_seen (
  player_id uuid not null references heritier.players(id) on delete cascade,
  question_id uuid not null references heritier.quiz_questions(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (player_id, question_id)
);

create table if not exists heritier.quiz_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references heritier.players(id) on delete cascade,
  game_id uuid not null references heritier.games(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'failed', 'cashed-out')),
  current_question integer not null default 1,
  current_question_id uuid references heritier.quiz_questions(id),
  current_earnings numeric(18,2) not null default 0,
  secured_amount numeric(18,2) not null default 0,
  skips_left integer not null default 3 check (skips_left between 0 and 3),
  selected_categories text[],
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists quiz_sessions_one_active_idx
  on heritier.quiz_sessions (player_id, game_id) where status = 'active';

create table if not exists heritier.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references heritier.quiz_sessions(id) on delete cascade,
  question_id uuid not null references heritier.quiz_questions(id),
  question_number integer not null,
  player_answer text check (player_answer is null or player_answer in ('A', 'B', 'C', 'D', 'SKIP', 'TIMEOUT', 'REVEAL')),
  is_correct boolean,
  prize_before numeric(18,2) not null default 0,
  prize_after numeric(18,2) not null default 0,
  answered_at timestamptz not null default now(),
  unique (session_id, question_number)
);

create table if not exists heritier.drag_runs (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references heritier.players(id) on delete cascade,
  game_id uuid not null references heritier.games(id) on delete cascade,
  stage integer not null,
  elapsed_ms integer not null,
  win boolean not null,
  perfect_shifts integer not null default 0,
  reward numeric(18,2) not null default 0,
  granted_reward numeric(18,2) not null default 0,
  device_info jsonb,
  created_at timestamptz not null default now()
);
create index if not exists drag_runs_player_created_idx
  on heritier.drag_runs (game_id, player_id, created_at desc);

create table if not exists heritier.referral_invites (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references heritier.games(id) on delete cascade,
  inviter_id uuid not null references heritier.players(id) on delete cascade,
  code text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired')),
  reward_amount numeric(18,2) not null default 1000000,
  accepted_by_id uuid references heritier.players(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create table if not exists heritier.prizes (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  amount_value integer not null,
  currency text not null default 'CAD',
  awarded_at timestamptz not null,
  winner_id uuid references heritier.players(id) on delete set null,
  winner_email text,
  game_id uuid references heritier.games(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists heritier.presence (
  player_id uuid primary key references heritier.players(id) on delete cascade,
  game_id uuid not null references heritier.games(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null,
  last_seen_at timestamptz not null default now()
);
create index if not exists presence_game_last_seen_idx
  on heritier.presence (game_id, last_seen_at desc);

create table if not exists heritier.event_feed (
  id bigint generated always as identity primary key,
  game_id uuid not null references heritier.games(id) on delete cascade,
  player_id uuid references heritier.players(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists event_feed_game_id_idx
  on heritier.event_feed (game_id, id desc);

-- Défense en profondeur: schéma privé, RLS activée et aucun droit Data API.
do $block$
declare
  t text;
begin
  foreach t in array array[
    'admins','games','players','property_templates','property_holdings',
    'repair_events','refinance_logs','listings','market_holdings','market_ticks',
    'dividend_logs','quiz_questions','quiz_question_seen','quiz_sessions',
    'quiz_attempts','drag_runs','referral_invites','prizes','presence','event_feed'
  ] loop
    execute format('alter table heritier.%I enable row level security', t);
  end loop;
end
$block$;

revoke all on schema heritier from public, anon, authenticated;
revoke all on all tables in schema heritier from public, anon, authenticated;
revoke all on all sequences in schema heritier from public, anon, authenticated;
alter default privileges in schema heritier revoke all on tables from public, anon, authenticated;
alter default privileges in schema heritier revoke all on sequences from public, anon, authenticated;

create or replace function heritier.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

drop trigger if exists games_touch_updated_at on heritier.games;
create trigger games_touch_updated_at before update on heritier.games
for each row execute function heritier.touch_updated_at();
drop trigger if exists players_touch_updated_at on heritier.players;
create trigger players_touch_updated_at before update on heritier.players
for each row execute function heritier.touch_updated_at();
drop trigger if exists holdings_touch_updated_at on heritier.property_holdings;
create trigger holdings_touch_updated_at before update on heritier.property_holdings
for each row execute function heritier.touch_updated_at();

create or replace function heritier.record_event(
  p_game_id uuid,
  p_player_id uuid,
  p_type text,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id bigint;
begin
  if p_type is null or length(p_type) > 80 then
    raise exception 'invalid event type';
  end if;
  insert into heritier.event_feed(game_id, player_id, type, payload)
  values (p_game_id, p_player_id, p_type, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$function$;

create or replace function heritier.recalculate_player(p_player_id uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_net numeric(18,2);
begin
  select round((p.cash
    + coalesce((select sum(h.current_value - h.mortgage_debt)
                from heritier.property_holdings h where h.player_id = p.id), 0)
    + coalesce((select sum(m.quantity * latest.price)
                from heritier.market_holdings m
                join lateral (
                  select mt.price
                  from heritier.market_ticks mt
                  where mt.game_id = m.game_id and mt.symbol = m.symbol
                  order by mt.at desc limit 1
                ) latest on true
                where m.player_id = p.id), 0))::numeric, 2)
    into v_net
  from heritier.players p
  where p.id = p_player_id;

  if v_net is null then
    raise exception 'player not found';
  end if;

  update heritier.players set net_worth = v_net where id = p_player_id;
  return v_net;
end
$function$;

create or replace function heritier.distribute_tokens()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update heritier.players
  set quiz_tokens = least(20, quiz_tokens + floor(extract(epoch from (clock_timestamp() - quiz_tokens_updated_at)) / 3600)::integer),
      quiz_tokens_updated_at = quiz_tokens_updated_at
        + floor(extract(epoch from (clock_timestamp() - quiz_tokens_updated_at)) / 3600)::integer * interval '1 hour'
  where quiz_tokens < 20
    and quiz_tokens_updated_at <= clock_timestamp() - interval '1 hour';

  update heritier.players
  set pari_tokens = least(100, pari_tokens + floor(extract(epoch from (clock_timestamp() - pari_tokens_updated_at)) / 3600)::integer * 5),
      pari_tokens_updated_at = pari_tokens_updated_at
        + floor(extract(epoch from (clock_timestamp() - pari_tokens_updated_at)) / 3600)::integer * interval '1 hour'
  where pari_tokens < 100
    and pari_tokens_updated_at <= clock_timestamp() - interval '1 hour';
end
$function$;

create or replace function heritier.market_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  g record;
  s text;
  v_last numeric;
  v_drift numeric;
  v_vol numeric;
  v_next numeric;
begin
  for g in select id from heritier.games where status = 'running' loop
    foreach s in array array['SP500','QQQ','TSX','GLD','TLT'] loop
      select price into v_last
      from heritier.market_ticks
      where game_id = g.id and symbol = s
      order by at desc limit 1;
      v_last := coalesce(v_last, case s when 'SP500' then 5000 when 'QQQ' then 450 when 'TSX' then 21000 when 'GLD' then 190 else 90 end);
      v_drift := case s when 'QQQ' then 0.00045 when 'SP500' then 0.00035 when 'TSX' then 0.00030 when 'GLD' then 0.00020 else 0.00015 end;
      v_vol := case s when 'QQQ' then 0.018 when 'SP500' then 0.012 when 'TSX' then 0.011 when 'GLD' then 0.010 else 0.008 end;
      v_next := greatest(0.01, v_last * (1 + v_drift + ((random()+random()+random()+random()+random()+random())-3) * v_vol));
      insert into heritier.market_ticks(game_id, symbol, price) values (g.id, s, round(v_next, 6));
    end loop;
  end loop;
end
$function$;

create or replace function heritier.hourly_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_player record;
begin
  update heritier.games
  set inflation_index = inflation_index * power(1 + inflation_annual, 1.0 / 52.0)
  where status = 'running';

  update heritier.players player_row
  set cash = player_row.cash + flow.delta
  from (
    select h.player_id,
      sum(h.current_rent - h.weekly_payment
          - (t.taxes + t.insurance + t.maintenance) / 52.0) as delta
    from heritier.property_holdings h
    join heritier.property_templates t on t.id = h.template_id
    join heritier.games g on g.id = h.game_id and g.status = 'running'
    group by h.player_id
  ) flow
  where player_row.id = flow.player_id;

  update heritier.property_holdings h
  set accumulated_rent = h.accumulated_rent + h.current_rent,
      accumulated_interest_paid = h.accumulated_interest_paid + least(h.weekly_payment, h.mortgage_debt * h.mortgage_rate / 52.0),
      accumulated_taxes_paid = h.accumulated_taxes_paid + t.taxes / 52.0,
      accumulated_insurance_paid = h.accumulated_insurance_paid + t.insurance / 52.0,
      accumulated_maintenance_paid = h.accumulated_maintenance_paid + t.maintenance / 52.0,
      accumulated_net_cashflow = h.accumulated_net_cashflow + h.current_rent - h.weekly_payment - (t.taxes + t.insurance + t.maintenance) / 52.0,
      mortgage_debt = greatest(0, h.mortgage_debt - greatest(0, h.weekly_payment - h.mortgage_debt * h.mortgage_rate / 52.0)),
      current_value = h.current_value * power(1 + g.appreciation_annual + g.inflation_annual, 1.0 / 52.0),
      current_rent = h.current_rent * power(1 + g.inflation_annual, 1.0 / 52.0),
      weeks_elapsed = h.weeks_elapsed + 1
  from heritier.property_templates t, heritier.games g
  where t.id = h.template_id and g.id = h.game_id and g.status = 'running';

  for v_player in select id from heritier.players loop
    perform heritier.recalculate_player(v_player.id);
  end loop;
end
$function$;

create or replace function heritier.cleanup_runtime_data()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from heritier.presence where last_seen_at < clock_timestamp() - interval '90 seconds';
  delete from heritier.event_feed where created_at < clock_timestamp() - interval '30 days';
  delete from heritier.market_ticks mt
  using (
    select id from (
      select id, row_number() over (partition by game_id, symbol order by at desc) as rn
      from heritier.market_ticks
    ) ranked where rn > 1500
  ) old
  where mt.id = old.id;
end
$function$;

revoke all on all functions in schema heritier from public, anon, authenticated;

-- Partie mondiale et premiers cours.
insert into heritier.games(code, status, started_at, inflation_annual)
values ('GLOBAL', 'running', now(), 0.02)
on conflict (code) do update set status = 'running', started_at = coalesce(heritier.games.started_at, excluded.started_at);

insert into heritier.market_ticks(game_id, symbol, price)
select g.id, seed.symbol, seed.price
from heritier.games g
cross join (values
  ('SP500', 5000::numeric), ('QQQ', 450::numeric), ('TSX', 21000::numeric),
  ('GLD', 190::numeric), ('TLT', 90::numeric)
) as seed(symbol, price)
where g.code = 'GLOBAL'
  and not exists (
    select 1 from heritier.market_ticks mt
    where mt.game_id = g.id and mt.symbol = seed.symbol
  );

-- Banque immobilière de départ, reproductible et idempotente.
with generated as (
  select n,
    (array[1,2,3,6,50,100])[1 + ((n - 1) % 6)] as units,
    (array['Montréal','Québec','Laval','Gatineau','Sherbrooke','Trois-Rivières'])[1 + ((n - 1) % 6)] as city
  from generate_series(1, 60) n
)
insert into heritier.property_templates(
  name, description, price, base_rent, taxes, insurance, maintenance, units,
  city, address, postal_code, year_built, surface_area, land_area, image_url,
  plumbing_state, electricity_state, roof_state, floors
)
select
  case units
    when 1 then 'Maison Héritage ' || lpad(n::text, 2, '0')
    when 2 then 'Duplex Capital ' || lpad(n::text, 2, '0')
    when 3 then 'Triplex Patrimoine ' || lpad(n::text, 2, '0')
    when 6 then 'Sixplex Revenu ' || lpad(n::text, 2, '0')
    when 50 then 'Tour Horizon ' || lpad(n::text, 2, '0')
    else 'Complexe Centenaire ' || lpad(n::text, 2, '0') end,
  units || ' logement(s) au Québec, sélectionné(s) pour une simulation financière réaliste.',
  round((case units when 1 then 330000 when 2 then 540000 when 3 then 735000 when 6 then 1450000 when 50 then 13750000 else 25500000 end) * (0.94 + n * 0.002), 2),
  round((case units when 1 then 430 when 2 then 450 when 3 then 475 when 6 then 510 when 50 then 600 else 625 end), 2),
  round((case units when 1 then 3200 when 2 then 5100 when 3 then 6900 when 6 then 12800 when 50 then 95000 else 175000 end) * (0.95 + n * 0.001), 2),
  round((case units when 1 then 1400 when 2 then 2100 when 3 then 2700 when 6 then 4700 when 50 then 36000 else 68000 end) * (0.95 + n * 0.001), 2),
  round((case units when 1 then 2500 when 2 then 3900 when 3 then 5200 when 6 then 9800 when 50 then 80000 else 145000 end) * (0.95 + n * 0.001), 2),
  units, city, (100 + n) || ', rue de la Fortune', 'H0H 0H' || ((n - 1) % 9 + 1),
  1960 + ((n * 7) % 61), 90 + units * 72, 220 + units * 95,
  case when units = 1 then '/images/props/maison.svg'
       when units = 2 then '/images/props/duplex.svg'
       when units = 3 then '/images/props/triplex.svg'
       when units = 6 then '/images/props/6plex.svg'
       else '/images/props/condo-tower.svg' end,
  case when n % 5 = 0 then 'moyen' else 'bon' end,
  case when n % 7 = 0 then 'moyen' else 'bon' end,
  case when n % 9 = 0 then 'à rénover' else 'bon' end,
  greatest(1, ceil(units / 8.0)::integer)
from generated
on conflict (name) do nothing;

-- Questions initiales. Les réponses sont validées exclusivement côté serveur.
insert into heritier.quiz_questions(question, option_a, option_b, option_c, option_d, correct_answer, difficulty, category, image_url)
values
('Quel est le montant de départ dans Héritier Millionnaire ?', '100 000 $', '500 000 $', '1 000 000 $', '10 000 000 $', 'C', 'easy', 'finance', '/images/quiz/easy1.svg'),
('Que représente le symbole GLD ?', 'L’or', 'Le pétrole', 'Une banque', 'Une obligation', 'A', 'easy', 'finance', '/images/quiz/easy2.svg'),
('Qu’est-ce qu’une mise de fonds ?', 'Un loyer', 'La part payée comptant à l’achat', 'Un dividende', 'Une taxe', 'B', 'easy', 'real-estate', '/images/quiz/easy3.svg'),
('Quel actif suit les grandes entreprises américaines ?', 'TSX', 'GLD', 'SP500', 'TLT', 'C', 'easy', 'finance', '/images/quiz/easy4.svg'),
('Un budget sert d’abord à quoi ?', 'Prévoir revenus et dépenses', 'Garantir un profit', 'Éviter les impôts', 'Créer du crédit', 'A', 'easy', 'economy', '/images/quiz/easy-default.svg'),
('Une obligation est principalement…', 'Une part de maison', 'Un prêt à un émetteur', 'Une devise', 'Une assurance', 'B', 'easy', 'finance', '/images/quiz/easy-default.svg'),
('Le revenu d’un logement loué s’appelle…', 'Un dividende', 'Un coupon', 'Un loyer', 'Une marge', 'C', 'easy', 'real-estate', '/images/quiz/easy-default.svg'),
('Pourquoi diversifier ses placements ?', 'Pour éliminer tout risque', 'Pour répartir le risque', 'Pour doubler automatiquement', 'Pour éviter les frais', 'B', 'easy', 'finance', '/images/quiz/easy-default.svg'),
('Quel organe pompe le sang ?', 'Le foie', 'Le cœur', 'Le rein', 'Le poumon', 'B', 'easy', 'anatomy', '/images/quiz/easy-default.svg'),
('Quel est le plus grand océan ?', 'Atlantique', 'Indien', 'Arctique', 'Pacifique', 'D', 'easy', 'geography', '/images/quiz/easy-default.svg'),
('À quoi sert le ratio prêt-valeur ?', 'Comparer la dette à la valeur du bien', 'Mesurer le loyer', 'Calculer les taxes', 'Mesurer la surface', 'A', 'medium', 'real-estate', '/images/quiz/medium-default.svg'),
('Si les taux montent, le coût d’un prêt variable tend à…', 'Baisser', 'Rester nul', 'Monter', 'Disparaître', 'C', 'medium', 'economy', '/images/quiz/medium-default.svg'),
('Le rendement composé signifie que…', 'Les gains peuvent produire des gains', 'Les pertes sont impossibles', 'Le capital est fixe', 'Les impôts doublent', 'A', 'medium', 'finance', '/images/quiz/medium-default.svg'),
('Quel indice représente surtout le marché canadien ?', 'QQQ', 'TSX', 'GLD', 'TLT', 'B', 'medium', 'finance', '/images/quiz/medium-default.svg'),
('Une marge de crédit utilise généralement…', 'Un taux d’intérêt', 'Un loyer fixe', 'Un dividende', 'Une action gratuite', 'A', 'medium', 'finance', '/images/quiz/medium-default.svg'),
('Quel effet l’inflation a-t-elle sur le pouvoir d’achat ?', 'Elle l’augmente toujours', 'Elle le réduit à prix croissants', 'Aucun effet', 'Elle supprime les taxes', 'B', 'medium', 'economy', '/images/quiz/medium-default.svg'),
('Le cashflow immobilier net correspond surtout à…', 'Loyer moins dépenses et dette', 'Prix moins superficie', 'Valeur plus taxes', 'Dette plus intérêt', 'A', 'medium', 'real-estate', '/images/quiz/medium-default.svg'),
('Quel actif est souvent défensif face à l’incertitude ?', 'GLD', 'QQQ', 'Une dette chère', 'Un découvert', 'A', 'medium', 'finance', '/images/quiz/medium-default.svg'),
('Quelle structure contient l’ADN dans la cellule humaine ?', 'Le noyau', 'La membrane seulement', 'Le plasma sanguin', 'Le tendon', 'A', 'medium', 'anatomy', '/images/quiz/medium-default.svg'),
('Quelle province a Québec pour capitale ?', 'Ontario', 'Québec', 'Alberta', 'Manitoba', 'B', 'medium', 'quebec', '/images/quiz/medium-default.svg'),
('Un actif a 12 % de rendement puis perd 12 %. Le résultat est…', 'Exactement zéro', 'Un léger gain', 'Une légère perte', 'Un gain de 24 %', 'C', 'hard', 'finance', '/images/quiz/hard-default.svg'),
('Pourquoi la duration rend-elle une obligation sensible aux taux ?', 'Elle mesure la sensibilité approximative du prix', 'Elle fixe les taxes', 'Elle garantit le coupon', 'Elle annule l’inflation', 'A', 'hard', 'finance', '/images/quiz/hard-default.svg'),
('Un immeuble vaut 1 M$ avec 600 k$ de dette. Son équité est…', '400 k$', '600 k$', '1,6 M$', '100 k$', 'A', 'hard', 'real-estate', '/images/quiz/hard-default.svg'),
('À rendement égal, quel portefeuille est généralement moins volatil ?', 'Un seul titre', 'Plusieurs actifs faiblement corrélés', 'Tout en espèces empruntées', 'Un seul secteur', 'B', 'hard', 'finance', '/images/quiz/hard-default.svg'),
('Le bêta d’un actif mesure principalement…', 'Son dividende', 'Sa sensibilité au marché', 'Sa liquidité bancaire', 'Son impôt', 'B', 'hard', 'finance', '/images/quiz/hard-default.svg'),
('Quel mécanisme protège une transaction concurrente en base ?', 'Une transaction avec verrou', 'Un délai visuel', 'Un cookie', 'Une couleur de bouton', 'A', 'hard', 'technology', '/images/quiz/hard-default.svg'),
('Si A implique B et B implique C, alors…', 'C implique toujours A', 'A implique C', 'A exclut C', 'Rien ne suit', 'B', 'hard', 'logic', '/images/quiz/hard-default.svg'),
('Le coût moyen pondéré du capital combine…', 'Dette et capitaux propres', 'Loyer et superficie', 'Or et pétrole', 'Salaire et taxes seulement', 'A', 'hard', 'finance', '/images/quiz/hard-default.svg'),
('Quelle valve sépare l’oreillette gauche du ventricule gauche ?', 'Aortique', 'Mitrale', 'Pulmonaire', 'Tricuspide', 'B', 'hard', 'anatomy', '/images/quiz/hard-default.svg'),
('Une corrélation de -1 indique…', 'Des mouvements opposés parfaits', 'Aucune relation', 'Des mouvements identiques', 'Un rendement nul', 'A', 'hard', 'finance', '/images/quiz/hard-default.svg')
on conflict (question) do nothing;

-- Administrateur initial résolu par identité, jamais par identifiant généré en dur.
insert into heritier.admins(user_id)
select id from auth.users where lower(email) = 'simonmorin30@gmail.com'
on conflict (user_id) do nothing;

-- Tâches Supabase Cron. Les noms rendent la migration rejouable.
create extension if not exists pg_cron;
select cron.unschedule(jobid)
from cron.job
where jobname in ('heritier-market-tick', 'heritier-hourly-tick', 'heritier-token-distribution', 'heritier-runtime-cleanup');

select cron.schedule('heritier-market-tick', '*/12 * * * *', 'select heritier.market_tick()');
select cron.schedule('heritier-hourly-tick', '7 * * * *', 'select heritier.hourly_tick()');
select cron.schedule('heritier-token-distribution', '* * * * *', 'select heritier.distribute_tokens()');
select cron.schedule('heritier-runtime-cleanup', '*/10 * * * *', 'select heritier.cleanup_runtime_data()');
