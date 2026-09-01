-- Durcissement explicite des tables privées et index de jointure.
-- Toutes les lectures/écritures applicatives passent par l'Edge Function avec
-- la clé service_role. Les rôles Data API restent volontairement bloqués.

do $block$
declare
  table_name text;
begin
  foreach table_name in array array[
    'admins','games','players','property_templates','property_holdings',
    'repair_events','refinance_logs','listings','market_holdings','market_ticks',
    'dividend_logs','quiz_questions','quiz_question_seen','quiz_sessions',
    'quiz_attempts','drag_runs','referral_invites','prizes','presence','event_feed'
  ] loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'heritier'
        and tablename = table_name
        and policyname = 'deny_direct_data_api_access'
    ) then
      execute format(
        'create policy deny_direct_data_api_access on heritier.%I as restrictive for all to anon, authenticated using (false) with check (false)',
        table_name
      );
    end if;
  end loop;
end
$block$;

create index if not exists players_auth_user_id_idx
  on heritier.players (auth_user_id);
create index if not exists property_holdings_player_id_idx
  on heritier.property_holdings (player_id);
create index if not exists property_holdings_template_id_idx
  on heritier.property_holdings (template_id);
create index if not exists repair_events_holding_id_idx
  on heritier.repair_events (holding_id);
create index if not exists refinance_logs_holding_id_idx
  on heritier.refinance_logs (holding_id);
create index if not exists listings_seller_id_idx
  on heritier.listings (seller_id);
create index if not exists listings_template_id_idx
  on heritier.listings (template_id);
create index if not exists market_holdings_player_id_idx
  on heritier.market_holdings (player_id);
create index if not exists dividend_logs_player_id_idx
  on heritier.dividend_logs (player_id);
create index if not exists quiz_question_seen_question_id_idx
  on heritier.quiz_question_seen (question_id);
create index if not exists quiz_sessions_game_id_idx
  on heritier.quiz_sessions (game_id);
create index if not exists quiz_sessions_current_question_id_idx
  on heritier.quiz_sessions (current_question_id);
create index if not exists quiz_attempts_question_id_idx
  on heritier.quiz_attempts (question_id);
create index if not exists drag_runs_player_id_idx
  on heritier.drag_runs (player_id);
create index if not exists referral_invites_game_id_idx
  on heritier.referral_invites (game_id);
create index if not exists referral_invites_inviter_id_idx
  on heritier.referral_invites (inviter_id);
create index if not exists referral_invites_accepted_by_id_idx
  on heritier.referral_invites (accepted_by_id);
create index if not exists prizes_game_id_idx
  on heritier.prizes (game_id);
create index if not exists prizes_winner_id_idx
  on heritier.prizes (winner_id);
create index if not exists presence_auth_user_id_idx
  on heritier.presence (auth_user_id);
create index if not exists event_feed_player_id_idx
  on heritier.event_feed (player_id);
