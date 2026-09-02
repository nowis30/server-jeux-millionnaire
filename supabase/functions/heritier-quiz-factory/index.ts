import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.7";

const DB_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DB_URL) throw new Error("SUPABASE_DB_URL is required");
const sql: any = postgres(DB_URL, { max: 2, idle_timeout: 20, connect_timeout: 10, prepare: false });
const DEFAULT_MODEL = "gpt-5.6-luna";
const TARGET_PER_BUCKET = 20;
const BATCH_SIZE = 8;
const CATEGORIES = ["finance","economy","real-estate","business","technology","science","history","geography","sports","arts","cinema","music","literature","culture","nature","health","food","general","animals","translation","kids","enfants","quebec","definitions","religions","logic","iq","anatomy"] as const;
const DIFFICULTIES = ["easy","medium","hard"] as const;

type RecordValue = Record<string, unknown>;
function isRecord(v: unknown): v is RecordValue { return typeof v === "object" && v !== null && !Array.isArray(v); }
function outputText(v: unknown): string | null {
  if (!isRecord(v)) return null;
  if (typeof v.output_text === "string") return v.output_text;
  if (!Array.isArray(v.output)) return null;
  for (const out of v.output) {
    if (!isRecord(out) || !Array.isArray(out.content)) continue;
    for (const c of out.content) {
      if (isRecord(c) && c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }
  return null;
}
function clean(v: unknown, max: number): string { return typeof v === "string" ? v.trim().replace(/\s+/g," ").slice(0,max) : ""; }
function eq(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let n = 0; for (let i=0;i<x.length;i++) n |= x[i]^y[i]; return n===0;
}
async function responses(model:string,key:string,instructions:string,input:string,schema:RecordValue,max:number) {
  const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),25000);
  try {
    const r=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
      body:JSON.stringify({model,store:false,reasoning:{effort:"low"},max_output_tokens:max,instructions,input,text:{format:{type:"json_schema",name:"heritier_quiz_factory",strict:true,schema}}}),
      signal:controller.signal
    });
    if(!r.ok) {
      const detail = await r.text().catch(()=>"");
      throw new Error(`OpenAI ${r.status}: ${detail.slice(0,300)}`);
    }
    const body:unknown=await r.json(); const text=outputText(body); if(!text) throw new Error("Réponse vide"); return JSON.parse(text);
  } finally { clearTimeout(timer); }
}
function genSchema(count:number):RecordValue { return {type:"object",additionalProperties:false,required:["questions"],properties:{questions:{type:"array",minItems:1,maxItems:count,items:{type:"object",additionalProperties:false,required:["question","optionA","optionB","optionC","optionD","correctAnswer"],properties:{question:{type:"string"},optionA:{type:"string"},optionB:{type:"string"},optionC:{type:"string"},optionD:{type:"string"},correctAnswer:{enum:["A","B","C","D"]}}}}}}; }
function reviewSchema(count:number):RecordValue { return {type:"object",additionalProperties:false,required:["approved"],properties:{approved:{type:"array",minItems:count,maxItems:count,items:{type:"boolean"}}}}; }

Deno.serve(async (req:Request)=>{
  if(req.method!=="POST") return new Response(JSON.stringify({error:"method"}),{status:405,headers:{"content-type":"application/json"}});
  const secrets=await sql`select secret from heritier.quiz_factory_secrets where id=1`;
  const supplied=req.headers.get("x-quiz-factory-key")??""; const expected=String(secrets[0]?.secret??"");
  if(!expected || !supplied || !eq(supplied,expected)) return new Response(JSON.stringify({error:"forbidden"}),{status:403,headers:{"content-type":"application/json"}});
  const apiKey=Deno.env.get("OPENAI_API_KEY")?.trim()??""; if(!apiKey) return new Response(JSON.stringify({error:"ai_not_configured"}),{status:503,headers:{"content-type":"application/json"}});
  const model=Deno.env.get("QUIZ_AI_MODEL")?.trim()||DEFAULT_MODEL;

  const buckets=await sql`
    with cats(category) as (select unnest(${CATEGORIES}::text[])), diffs(difficulty) as (select unnest(${DIFFICULTIES}::text[]))
    select cats.category,diffs.difficulty,count(q.id)::integer as n
    from cats cross join diffs
    left join heritier.quiz_questions q on q.active and q.category=cats.category and q.difficulty=diffs.difficulty
    group by cats.category,diffs.difficulty
    order by n asc, random() limit 1
  `;
  const category=String(buckets[0]?.category??"general"), difficulty=String(buckets[0]?.difficulty??"easy"), current=Number(buckets[0]?.n??0);
  if(current>=TARGET_PER_BUCKET) return new Response(JSON.stringify({ok:true,created:0,complete:true,minPerBucket:current,model}),{headers:{"content-type":"application/json"}});

  const existing=await sql`select question from heritier.quiz_questions where active and category=${category} and difficulty=${difficulty} order by created_at desc limit 120`;
  const forbidden=existing.map((r:any)=>String(r.question)).join("\n");
  const instructions=`Tu crées des QCM en français canadien pour Héritier Millionnaire. Catégorie: ${category}. Difficulté: ${difficulty}. Chaque question doit tester un concept distinct de toutes les questions interdites et des autres candidates. Aucune paraphrase, aucun même calcul avec seulement d'autres nombres. Une seule réponse correcte. Utilise des faits stables, vérifiables et non controversés; aucune actualité. Pour santé/anatomie, reste éducatif et non diagnostique. easy=accessible, medium=application/compréhension, hard=raisonnement ou connaissance précise. Respecte exactement le JSON.`;
  let generated:unknown;
  try { generated=await responses(model,apiKey,instructions,`Produis jusqu'à ${BATCH_SIZE} questions. Interdit de reformuler:\n${forbidden||"aucune"}`,genSchema(BATCH_SIZE),5000); }
  catch(e){ console.error("generate",e); return new Response(JSON.stringify({error:"generation_failed",detail:e instanceof Error?e.message:"unknown"}),{status:502,headers:{"content-type":"application/json"}}); }
  const raw=isRecord(generated)&&Array.isArray(generated.questions)?generated.questions:[];
  const candidates=raw.flatMap((v:any)=>{ if(!isRecord(v))return[]; const q=clean(v.question,260),a=clean(v.optionA,160),b=clean(v.optionB,160),c=clean(v.optionC,160),d=clean(v.optionD,160),correct=clean(v.correctAnswer,1); if(q.length<18||!a||!b||!c||!d||!["A","B","C","D"].includes(correct)||new Set([a,b,c,d].map(x=>x.toLowerCase())).size!==4)return[]; return [{question:q,optionA:a,optionB:b,optionC:c,optionD:d,correctAnswer:correct}]; });
  if(!candidates.length) return new Response(JSON.stringify({error:"no_candidates"}),{status:502,headers:{"content-type":"application/json"}});

  let reviewed:unknown;
  try { reviewed=await responses(model,apiKey,`Tu es le vérificateur strict de QCM. Catégorie ${category}, difficulté ${difficulty}. Pour chaque candidat, retourne exactement un booléen dans le même ordre. true seulement si la question est factuellement exacte, non ambiguë, possède exactement une bonne réponse, correspond au niveau demandé et teste un concept réellement distinct des concepts interdits et des autres candidats. En cas de doute, false.`,`Candidats:\n${JSON.stringify(candidates)}\n\nInterdits:\n${forbidden||"aucun"}`,reviewSchema(candidates.length),1200); }
  catch(e){ console.error("review",e); return new Response(JSON.stringify({error:"review_failed",detail:e instanceof Error?e.message:"unknown"}),{status:502,headers:{"content-type":"application/json"}}); }
  const flags=isRecord(reviewed)&&Array.isArray(reviewed.approved)?reviewed.approved:[];
  let created=0, approved=0;
  for(let i=0;i<candidates.length;i++){
    if(flags[i]!==true) continue;
    approved++;
    const q=candidates[i];
    try { await sql`insert into heritier.quiz_questions(question,option_a,option_b,option_c,option_d,correct_answer,difficulty,category,image_url,active,bank_version,source,model,verified_at,quality_score) values(${q.question},${q.optionA},${q.optionB},${q.optionC},${q.optionD},${q.correctAnswer},${difficulty},${category},null,true,'ai-live','ai-verified',${model},now(),0.950)`; created++; }
    catch(e){ console.info("rejected",e instanceof Error?e.message:String(e)); }
  }
  return new Response(JSON.stringify({ok:true,created,approved,candidates:candidates.length,category,difficulty,before:current,model}),{headers:{"content-type":"application/json"}});
});
