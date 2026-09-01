-- Évite le conflit de nom entre la variable PL/pgSQL et l'alias de table.
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

revoke all on function heritier.hourly_tick() from public, anon, authenticated;
