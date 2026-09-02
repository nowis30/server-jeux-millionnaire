create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

alter table heritier.quiz_questions add column if not exists bank_version text not null default 'legacy';
alter table heritier.quiz_questions add column if not exists source text not null default 'legacy';
alter table heritier.quiz_questions add column if not exists model text;
alter table heritier.quiz_questions add column if not exists verified_at timestamptz;
alter table heritier.quiz_questions add column if not exists quality_score numeric(4,3);

create or replace function heritier.quiz_normalize(value text)
returns text
language sql
stable
set search_path = heritier, public, extensions
as $$
  select coalesce(string_agg(token, ' ' order by ord), '')
  from unnest(regexp_split_to_array(lower(extensions.unaccent(coalesce(value, ''))), '[^a-z0-9]+')) with ordinality as words(token, ord)
  where token <> ''
    and length(token) > 1
    and token not in (
      'le','la','les','un','une','des','du','de','et','ou','est','sont','quel','quelle','quels','quelles',
      'que','qui','quoi','dans','sur','au','aux','pour','par','avec','sans','ce','cet','cette','ces','son','sa','ses',
      'leur','leurs','plus','moins','comme','si','on','nous','vous','ils','elles','il','elle','se','en','ne','pas',
      'principalement','generalement','suivant','suivante','parmi','choix','signifie','represente'
    );
$$;

create or replace function heritier.guard_quiz_question_uniqueness()
returns trigger
language plpgsql
set search_path = heritier, public, extensions
as $$
declare
  normalized_new text;
  conflicting record;
begin
  if not new.active then return new; end if;

  if new.correct_answer not in ('A','B','C','D') then
    raise exception 'correct_answer invalide';
  end if;
  if new.option_a is null or new.option_b is null or new.option_c is null or new.option_d is null then
    raise exception 'quatre réponses requises';
  end if;
  if new.option_a = new.option_b or new.option_a = new.option_c or new.option_a = new.option_d
     or new.option_b = new.option_c or new.option_b = new.option_d or new.option_c = new.option_d then
    raise exception 'les quatre réponses doivent être différentes';
  end if;

  normalized_new := heritier.quiz_normalize(new.question);
  if length(normalized_new) < 5 then raise exception 'question trop courte ou invalide'; end if;

  select q.id, q.question, q.category,
         extensions.similarity(heritier.quiz_normalize(q.question), normalized_new) as similarity_score
    into conflicting
  from heritier.quiz_questions q
  where q.active and q.id <> new.id
    and (
      heritier.quiz_normalize(q.question) = normalized_new
      or extensions.similarity(heritier.quiz_normalize(q.question), normalized_new) >= 0.78
      or (q.category = new.category and extensions.similarity(heritier.quiz_normalize(q.question), normalized_new) >= 0.58)
    )
  order by similarity_score desc
  limit 1;

  if found then
    raise exception 'question trop similaire à une question active existante (%): %',
      round(conflicting.similarity_score::numeric, 3), conflicting.question;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_quiz_question_uniqueness on heritier.quiz_questions;
create trigger trg_guard_quiz_question_uniqueness
before insert or update of question, category, active, option_a, option_b, option_c, option_d, correct_answer
on heritier.quiz_questions
for each row execute function heritier.guard_quiz_question_uniqueness();
