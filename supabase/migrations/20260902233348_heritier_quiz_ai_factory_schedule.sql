create extension if not exists pg_net with schema extensions;

create table if not exists heritier.quiz_factory_secrets (
  id smallint primary key check (id = 1),
  secret text not null,
  created_at timestamptz not null default now()
);
revoke all on heritier.quiz_factory_secrets from anon, authenticated, public;

insert into heritier.quiz_factory_secrets(id, secret)
values (1, gen_random_uuid()::text || gen_random_uuid()::text)
on conflict (id) do nothing;

do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='heritier-quiz-factory' limit 1;
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
end $$;

select cron.schedule(
  'heritier-quiz-factory',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url := 'https://smwrpejnegtssmtmnecb.supabase.co/functions/v1/heritier-quiz-factory',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-quiz-factory-key', (select secret from heritier.quiz_factory_secrets where id=1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);
