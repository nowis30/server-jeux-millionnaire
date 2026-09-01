import {
  ApiError,
  type AuthUser,
  body,
  fail,
  iso,
  json,
  mapQuestion,
  n,
  playerFor,
  quizPrize,
  secondsUntil,
  selectQuizQuestion,
  sql,
} from "./lib.ts";

const UUID="[0-9a-fA-F-]{36}";
const VALID_CATEGORIES=new Set([
  "finance","economy","real-estate","business","technology","science","history","geography","sports","arts","cinema","music","literature","culture","nature","health","food","general","animals","translation","kids","enfants","quebec","definitions","religions","logic","iq","anatomy",
]);

function needUser(user:AuthUser|null):AuthUser{if(!user)throw new ApiError(401,"Connexion requise");return user;}
function sessionPayload(row:any):Record<string,unknown>{
  return {id:row.id,currentQuestion:Number(row.current_question),currentEarnings:n(row.current_earnings),securedAmount:n(row.secured_amount),nextPrize:quizPrize(Number(row.current_question)),skipsLeft:Number(row.skips_left),status:row.status,startedAt:iso(row.started_at)};
}

async function activeSession(db:any,gameId:string,playerId:string,lock=false):Promise<any>{
  const rows=lock
    ? await db`select * from heritier.quiz_sessions where game_id=${gameId}::uuid and player_id=${playerId}::uuid and status='active' for update`
    : await db`select * from heritier.quiz_sessions where game_id=${gameId}::uuid and player_id=${playerId}::uuid and status='active' limit 1`;
  return rows[0]??null;
}

async function finishFailed(tx:any,session:any,playerId:string,question:any,answer:string):Promise<Record<string,unknown>>{
  const secured=n(session.secured_amount);
  await tx`insert into heritier.quiz_question_seen(player_id,question_id) values(${playerId}::uuid,${question.id}::uuid) on conflict do nothing`;
  await tx`insert into heritier.quiz_attempts(session_id,question_id,question_number,player_answer,is_correct,prize_before,prize_after) values(${session.id}::uuid,${question.id}::uuid,${Number(session.current_question)},${answer},false,${n(session.current_earnings)},${secured})`;
  await tx`update heritier.quiz_sessions set status='failed',completed_at=now() where id=${session.id}::uuid`;
  if(secured>0) await tx`update heritier.players set cash=cash+${secured},cumulative_quiz_gain=cumulative_quiz_gain+${secured} where id=${playerId}::uuid`;
  await tx`select heritier.recalculate_player(${playerId}::uuid)`;
  return {correct:false,correctAnswer:question.correct_answer,completed:true,finalPrize:secured,message:secured>0?`Mauvaise réponse. Votre palier sécurisé de ${secured.toLocaleString("fr-CA")} $ est crédité.`:"Mauvaise réponse. La session est terminée."};
}

async function advanceCorrect(tx:any,session:any,playerId:string,question:any,answerLabel:string):Promise<Record<string,unknown>>{
  const qn=Number(session.current_question),prize=quizPrize(qn),secured=qn===5?prize:n(session.secured_amount);
  await tx`insert into heritier.quiz_question_seen(player_id,question_id) values(${playerId}::uuid,${question.id}::uuid) on conflict do nothing`;
  await tx`insert into heritier.quiz_attempts(session_id,question_id,question_number,player_answer,is_correct,prize_before,prize_after) values(${session.id}::uuid,${question.id}::uuid,${qn},${answerLabel},true,${n(session.current_earnings)},${prize})`;
  if(qn>=10){
    await tx`update heritier.quiz_sessions set status='completed',current_earnings=${prize},secured_amount=${secured},completed_at=now() where id=${session.id}::uuid`;
    await tx`update heritier.players set cash=cash+${prize},cumulative_quiz_gain=cumulative_quiz_gain+${prize} where id=${playerId}::uuid`;
    await tx`select heritier.recalculate_player(${playerId}::uuid)`;
    return {correct:true,completed:true,finalPrize:prize,currentQuestion:qn,currentEarnings:prize,securedAmount:secured,skipsLeft:Number(session.skips_left),message:`Quiz réussi ! ${prize.toLocaleString("fr-CA")} $ ont été crédités.`};
  }
  const nextNumber=qn+1,categories=Array.isArray(session.selected_categories)?session.selected_categories:[];
  const next=await selectQuizQuestion(tx,playerId,nextNumber,categories);
  await tx`update heritier.quiz_sessions set current_question=${nextNumber},current_question_id=${next.id}::uuid,current_earnings=${prize},secured_amount=${secured} where id=${session.id}::uuid`;
  return {correct:true,completed:false,currentQuestion:nextNumber,currentEarnings:prize,securedAmount:secured,skipsLeft:Number(session.skips_left),nextPrize:quizPrize(nextNumber),question:mapQuestion(next),message:"Bonne réponse !"};
}

export async function handleQuiz(req:Request,_url:URL,path:string,user:AuthUser|null):Promise<Response|null>{
  const method=req.method.toUpperCase();
  if(path==="/api/quiz/public-stats"&&method==="GET"){
    const totals=await sql`select difficulty,count(*)::integer as total from heritier.quiz_questions where active group by difficulty`;
    const categories=await sql`select category,count(*)::integer as total from heritier.quiz_questions where active group by category order by category`;
    const usedRows=await sql`select count(distinct question_id)::integer as used from heritier.quiz_question_seen`;
    const total=totals.reduce((sum:number,row:any)=>sum+Number(row.total),0),used=Number(usedRows[0]?.used??0);
    const byDiff=Object.fromEntries(totals.map((row:any)=>[row.difficulty,Number(row.total)]));
    const byCat=Object.fromEntries(categories.map((row:any)=>[row.category,Number(row.total)]));
    return json({total,used,remaining:Math.max(0,total-used),remainingByDifficulty:{easy:byDiff.easy??0,medium:byDiff.medium??0,hard:byDiff.hard??0},remainingByCategory:{finance:byCat.finance??0,economy:byCat.economy??0,realEstate:byCat["real-estate"]??0},categories:categories.map((row:any)=>({category:row.category,total:Number(row.total),used:0,remaining:Number(row.total)}))});
  }

  let match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/status$`));
  if(match&&method==="GET"){
    const actor=needUser(user);await sql`select heritier.distribute_tokens()`;
    const player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const session=await activeSession(sql,match[1],player.id);
    const seconds=Number(player.quiz_tokens)>=20?0:Math.max(0,Math.ceil(3600-((Date.now()-new Date(String(player.quiz_tokens_updated_at)).getTime())/1000)%3600));
    return json({tokens:Number(player.quiz_tokens),maxTokens:20,canPlay:Number(player.quiz_tokens)>0,secondsUntilNextToken:seconds,adCooldownSeconds:secondsUntil(player.last_ad_quiz_at,1800),hasActiveSession:Boolean(session),session:session?sessionPayload(session):null});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/start$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req);await sql`select heritier.distribute_tokens()`;
    const player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const requested=Array.isArray(payload.selectedCategories)?payload.selectedCategories.map(String):[];
    const categories=requested.filter((category)=>VALID_CATEGORIES.has(category)).slice(0,20);
    const result=await sql.begin(async(tx:any)=>{
      const existing=await activeSession(tx,match![1],player.id,true);
      if(existing){
        const questions=await tx`select * from heritier.quiz_questions where id=${existing.current_question_id}::uuid`;
        return {sessionId:existing.id,...sessionPayload(existing),question:mapQuestion(questions[0])};
      }
      const players=await tx`select * from heritier.players where id=${player.id}::uuid for update`;
      fail(Number(players[0].quiz_tokens)>0,403,"Aucun token Quiz disponible");
      const question=await selectQuizQuestion(tx,player.id,1,categories);
      await tx`update heritier.players set quiz_tokens=quiz_tokens-1 where id=${player.id}::uuid`;
      const sessions=await tx`insert into heritier.quiz_sessions(player_id,game_id,current_question,current_question_id,selected_categories) values(${player.id}::uuid,${match![1]}::uuid,1,${question.id}::uuid,${categories}::text[]) returning *`;
      return {sessionId:sessions[0].id,currentQuestion:1,currentEarnings:0,securedAmount:0,nextPrize:quizPrize(1),skipsLeft:3,question:mapQuestion(question)};
    });
    return json(result,201);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/resume$`));
  if(match&&method==="GET"){
    const actor=needUser(user),player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const session=await activeSession(sql,match[1],player.id);fail(session,404,"Aucune session active");
    const questions=await sql`select * from heritier.quiz_questions where id=${session.current_question_id}::uuid`;fail(questions[0],409,"Question active introuvable");
    return json({session:sessionPayload(session),question:mapQuestion(questions[0])});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/answer$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const sessionId=String(payload.sessionId??""),questionId=String(payload.questionId??""),answer=String(payload.answer??"").toUpperCase();fail(["A","B","C","D"].includes(answer),400,"Réponse invalide");
    const result=await sql.begin(async(tx:any)=>{
      const sessions=await tx`select * from heritier.quiz_sessions where id=${sessionId}::uuid and game_id=${match![1]}::uuid and player_id=${player.id}::uuid for update`;
      fail(sessions[0]&&sessions[0].status==="active",409,"Session inactive");fail(sessions[0].current_question_id===questionId,409,"Cette question n’est plus active");
      const questions=await tx`select * from heritier.quiz_questions where id=${questionId}::uuid`;fail(questions[0],404,"Question introuvable");
      const already=await tx`select 1 from heritier.quiz_attempts where session_id=${sessionId}::uuid and question_number=${Number(sessions[0].current_question)} limit 1`;fail(!already[0],409,"Réponse déjà enregistrée");
      return answer===questions[0].correct_answer?advanceCorrect(tx,sessions[0],player.id,questions[0],answer):finishFailed(tx,sessions[0],player.id,questions[0],answer);
    });
    return json(result);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/reveal$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const sessionId=String(payload.sessionId??""),questionId=String(payload.questionId??"");
    const result=await sql.begin(async(tx:any)=>{
      const sessions=await tx`select * from heritier.quiz_sessions where id=${sessionId}::uuid and game_id=${match![1]}::uuid and player_id=${player.id}::uuid for update`;
      fail(sessions[0]&&sessions[0].status==="active",409,"Session inactive");fail(sessions[0].current_question_id===questionId,409,"Cette question n’est plus active");
      const questions=await tx`select * from heritier.quiz_questions where id=${questionId}::uuid`;fail(questions[0],404,"Question introuvable");
      const advanced=await advanceCorrect(tx,sessions[0],player.id,questions[0],"REVEAL");
      return {revealed:true,correctAnswer:questions[0].correct_answer,...advanced,message:`Réponse ${questions[0].correct_answer} révélée ✅`};
    });
    return json(result);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/(skip|timeout)$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const sessionId=String(payload.sessionId??""),questionId=String(payload.questionId??"");
    const result=await sql.begin(async(tx:any)=>{
      const sessions=await tx`select * from heritier.quiz_sessions where id=${sessionId}::uuid and game_id=${match![1]}::uuid and player_id=${player.id}::uuid for update`;
      fail(sessions[0]&&sessions[0].status==="active",409,"Session inactive");fail(sessions[0].current_question_id===questionId,409,"Cette question n’est plus active");
      const questions=await tx`select * from heritier.quiz_questions where id=${questionId}::uuid`;fail(questions[0],404,"Question introuvable");
      if(match![2]==="timeout"){
        const failed=await finishFailed(tx,sessions[0],player.id,questions[0],"TIMEOUT");
        return {...failed,correctAnswer:questions[0].correct_answer,message:"Temps écoulé. La session est terminée."};
      }
      fail(Number(sessions[0].skips_left)>0,400,"Aucun saut disponible");
      const qn=Number(sessions[0].current_question);
      await tx`insert into heritier.quiz_question_seen(player_id,question_id) values(${player.id}::uuid,${questionId}::uuid) on conflict do nothing`;
      await tx`insert into heritier.quiz_attempts(session_id,question_id,question_number,player_answer,is_correct,prize_before,prize_after) values(${sessionId}::uuid,${questionId}::uuid,${qn},'SKIP',null,${n(sessions[0].current_earnings)},${n(sessions[0].current_earnings)})`;
      if(qn>=10){
        const prize=n(sessions[0].current_earnings);await tx`update heritier.quiz_sessions set status='completed',skips_left=skips_left-1,completed_at=now() where id=${sessionId}::uuid`;
        if(prize>0)await tx`update heritier.players set cash=cash+${prize},cumulative_quiz_gain=cumulative_quiz_gain+${prize} where id=${player.id}::uuid`;
        await tx`select heritier.recalculate_player(${player.id}::uuid)`;
        return {correctAnswer:questions[0].correct_answer,completed:true,finalPrize:prize,session:{...sessionPayload(sessions[0]),skipsLeft:Number(sessions[0].skips_left)-1}};
      }
      const nextNumber=qn+1,categories=Array.isArray(sessions[0].selected_categories)?sessions[0].selected_categories:[],next=await selectQuizQuestion(tx,player.id,nextNumber,categories);
      const updated=(await tx`update heritier.quiz_sessions set current_question=${nextNumber},current_question_id=${next.id}::uuid,skips_left=skips_left-1 where id=${sessionId}::uuid returning *`)[0];
      return {correctAnswer:questions[0].correct_answer,session:sessionPayload(updated),question:mapQuestion(next)};
    });
    return json(result);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/quiz/cash-out$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),player=await playerFor(actor,match[1],req.headers.get("x-player-id")),sessionId=String(payload.sessionId??"");
    const result=await sql.begin(async(tx:any)=>{
      const sessions=await tx`select * from heritier.quiz_sessions where id=${sessionId}::uuid and game_id=${match![1]}::uuid and player_id=${player.id}::uuid for update`;
      fail(sessions[0]&&sessions[0].status==="active",409,"Session inactive");const prize=n(sessions[0].current_earnings);
      await tx`update heritier.quiz_sessions set status='cashed-out',completed_at=now() where id=${sessionId}::uuid`;
      if(prize>0)await tx`update heritier.players set cash=cash+${prize},cumulative_quiz_gain=cumulative_quiz_gain+${prize} where id=${player.id}::uuid`;
      await tx`select heritier.recalculate_player(${player.id}::uuid)`;
      return {status:"ok",amount:prize,message:`Vous encaissez ${prize.toLocaleString("fr-CA")} $ !`};
    });
    return json(result);
  }

  return null;
}
