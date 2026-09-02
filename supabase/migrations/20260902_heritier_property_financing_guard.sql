-- Garde-fou immobilier : le client ne choisit jamais son taux hypothécaire.
-- Les PropertyTemplate.base_rent sont des loyers mensuels par unité alors que
-- PropertyHolding.current_rent est consommé par le tick hebdomadaire.

create or replace function heritier.enforce_property_financing()
returns trigger
language plpgsql
set search_path = heritier, public
as $$
declare
  market_rate numeric;
  template_rent numeric;
  template_units integer;
  weeks integer;
  weekly_rate numeric;
begin
  if tg_op = 'INSERT' then
    select g.base_mortgage_rate into market_rate
    from heritier.games g where g.id = new.game_id;
    if market_rate is null then
      raise exception 'Partie introuvable pour le financement';
    end if;

    select t.base_rent, t.units into template_rent, template_units
    from heritier.property_templates t where t.id = new.template_id;
    if template_rent is null then
      raise exception 'Immeuble introuvable pour le calcul du loyer';
    end if;

    new.mortgage_rate := market_rate;
    new.current_rent := round((template_rent * greatest(1, template_units) * 12.0 / 52.0)::numeric, 2);
    weeks := greatest(1, round(greatest(5, least(25, new.term_years)) * 52.0));
    weekly_rate := market_rate / 52.0;
    new.weekly_payment := case
      when new.mortgage_debt <= 0 then 0
      when weekly_rate <= 0 then new.mortgage_debt / weeks
      else (new.mortgage_debt * weekly_rate) / (1 - power(1 + weekly_rate, -weeks))
    end;
    return new;
  end if;

  if tg_op = 'UPDATE' and (
    new.mortgage_rate is distinct from old.mortgage_rate
    or new.term_years is distinct from old.term_years
    or new.mortgage_debt > old.mortgage_debt
    or new.weeks_elapsed < old.weeks_elapsed
  ) then
    select g.base_mortgage_rate into market_rate
    from heritier.games g where g.id = new.game_id;
    if market_rate is null then
      raise exception 'Partie introuvable pour le refinancement';
    end if;

    new.mortgage_rate := market_rate;
    weeks := greatest(1, round(greatest(5, least(25, new.term_years)) * 52.0));
    weekly_rate := market_rate / 52.0;
    new.weekly_payment := case
      when new.mortgage_debt <= 0 then 0
      when weekly_rate <= 0 then new.mortgage_debt / weeks
      else (new.mortgage_debt * weekly_rate) / (1 - power(1 + weekly_rate, -weeks))
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_property_financing_guard on heritier.property_holdings;
create trigger trg_property_financing_guard
before insert or update on heritier.property_holdings
for each row execute function heritier.enforce_property_financing();
