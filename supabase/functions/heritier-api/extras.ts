import {
  ApiError,
  type AuthUser,
  body,
  fail,
  iso,
  json,
  mapPlayer,
  n,
  number,
  playerFor,
  secondsUntil,
  sql,
  string,
} from "./lib.ts";

const UUID = "[0-9a-fA-F-]{36}";
const QUIZ_MAX = 20;
const PARI_MAX = 100;
const QUIZ_AD_REWARD = 20;
const PARI_AD_REWARD = 100;
const QUIZ_AD_COOLDOWN = 30 * 60;
const PARI_AD_COOLDOWN = 5 * 60;
const BONUS_REWARD = 1_000_000;
const BONUS_COOLDOWN = 5 * 60;

function needUser(user: AuthUser | null): AuthUser {
  if (!user) throw new ApiError(401, "Connexion requise");
  return user;
}

function tokenSeconds(updatedAt: unknown, current: number, max: number): number {
  if (current >= max) return 0;
  const elapsed = Math.max(0, (Date.now() - new Date(String(updatedAt)).getTime()) / 1000);
  return Math.max(0, Math.ceil(3600 - (elapsed % 3600)));
}

function randomDie(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return (values[0] % 6) + 1;
}

function evaluateDice(dice: [number, number, number]): { combination: string; multiplier: number; description: string } {
  const [a,b,c] = dice;
  const sorted = [...dice].sort((x,y)=>x-y);
  if (a===b && b===c) {
    const multiplier=a+b+c;
    return {combination:"triple",multiplier,description:`Triple ! x${multiplier}`};
  }
  if (sorted[0]+1===sorted[1] && sorted[1]+1===sorted[2]) return {combination:"suite",multiplier:2,description:"Suite consécutive ! x2"};
  if (a===b || a===c || b===c) {
    const repeated=a===b||a===c?a:b;
    return {combination:"double",multiplier:repeated,description:`Double de ${repeated} ! x${repeated}`};
  }
  return {combination:"aucun",multiplier:0,description:"Aucun combo gagnant"};
}

export async function handleExtras(req: Request, url: URL, path: string, user: AuthUser | null): Promise<Response | null> {
  const method=req.method.toUpperCase();
  let match=path.match(new RegExp(`^/api/games/(${UUID})/economy$`));
  if(match&&method==="GET"){
    needUser(user);
    const rows=await sql`select * from heritier.games where id=${match[1]}::uuid`;
    fail(rows[0],404,"Partie introuvable");
    const schedule=Array.from({length:10},(_,index)=>index===0?n(rows[0].appreciation_annual):Number((0.02+(((index*37+match![1].charCodeAt(index%match![1].length))%301)/10000)).toFixed(4)));
    return json({baseMortgageRate:n(rows[0].base_mortgage_rate),appreciationAnnual:n(rows[0].appreciation_annual),inflationAnnual:n(rows[0].inflation_annual),inflationIndex:n(rows[0].inflation_index),schedule});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/tokens$`));
  if(match&&method==="GET"){
    const actor=needUser(user); await sql`select heritier.distribute_tokens()`;
    const player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    return json({
      quiz:{tokens:Number(player.quiz_tokens),max:QUIZ_MAX,secondsUntilNext:tokenSeconds(player.quiz_tokens_updated_at,Number(player.quiz_tokens),QUIZ_MAX),adCooldownSeconds:secondsUntil(player.last_ad_quiz_at,QUIZ_AD_COOLDOWN),adReward:QUIZ_AD_REWARD},
      pari:{tokens:Number(player.pari_tokens),max:PARI_MAX,secondsUntilNext:tokenSeconds(player.pari_tokens_updated_at,Number(player.pari_tokens),PARI_MAX),adCooldownSeconds:secondsUntil(player.last_ad_pari_at,PARI_AD_COOLDOWN),adReward:PARI_AD_REWARD},
    });
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/(?:tokens/ads|pari/ad-recharge)$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),type=String(payload.type??"");
    fail(type==="quiz"||type==="pari",400,"Type de recharge invalide");
    const current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const result=await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      const last=type==="quiz"?rows[0].last_ad_quiz_at:rows[0].last_ad_pari_at;
      const cooldown=type==="quiz"?QUIZ_AD_COOLDOWN:PARI_AD_COOLDOWN;
      const remaining=secondsUntil(last,cooldown);
      if(remaining>0) throw new ApiError(429,`Recharge ${type==="quiz"?"Quiz":"Pari"} trop fréquente. Réessayez dans ${Math.ceil(remaining/60)} min.`);
      if(type==="quiz"){
        const before=Number(rows[0].quiz_tokens),next=Math.min(QUIZ_MAX,before+QUIZ_AD_REWARD),added=next-before;
        await tx`update heritier.players set quiz_tokens=${next},quiz_tokens_updated_at=case when ${added}>0 then now() else quiz_tokens_updated_at end,last_ad_quiz_at=now() where id=${current.id}::uuid`;
        return {ok:true,type,tokens:next,max:QUIZ_MAX,added,adReward:QUIZ_AD_REWARD,cooldownSeconds:QUIZ_AD_COOLDOWN};
      }
      const before=Number(rows[0].pari_tokens),next=PARI_MAX,added=next-before;
      await tx`update heritier.players set pari_tokens=${next},pari_tokens_updated_at=case when ${added}>0 then now() else pari_tokens_updated_at end,last_ad_pari_at=now() where id=${current.id}::uuid`;
      return {ok:true,type,tokens:next,max:PARI_MAX,added,adReward:PARI_AD_REWARD,cooldownSeconds:PARI_AD_COOLDOWN};
    });
    return json(result);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/pari/status$`));
  if(match&&method==="GET"){
    const actor=needUser(user); await sql`select heritier.distribute_tokens()`;
    const player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    return json({tokens:Number(player.pari_tokens),max:PARI_MAX,secondsUntilNext:tokenSeconds(player.pari_tokens_updated_at,Number(player.pari_tokens),PARI_MAX),canPlay:Number(player.pari_tokens)>0,adCooldownSeconds:secondsUntil(player.last_ad_pari_at,PARI_AD_COOLDOWN),adReward:PARI_AD_REWARD});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/pari/play$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),bet=number(payload.bet,"Mise",{min:5000,max:50000,integer:true});
    await sql`select heritier.distribute_tokens()`;
    const current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const dice:[number,number,number]=[randomDie(),randomDie(),randomDie()];
    const outcome=evaluateDice(dice);
    const result=await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      const cash=n(rows[0].cash),cap=Math.min(50000,Math.max(5000,Math.floor(Math.max(0,cash)*0.5)));
      fail(bet<=cap,400,`Mise trop élevée (max ${cap})`); fail(cash>=bet,400,"Encaisse insuffisante"); fail(Number(rows[0].pari_tokens)>0,403,"Pas assez de tokens Pari");
      const gain=bet*outcome.multiplier,net=gain-bet;
      const updated=await tx`update heritier.players set cash=cash+${net},cumulative_pari_gain=cumulative_pari_gain+${net},pari_tokens=pari_tokens-1 where id=${current.id}::uuid returning cash,pari_tokens`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`;
      await tx`select heritier.record_event(${match![1]}::uuid,${current.id}::uuid,'pari:play',jsonb_build_object('bet',${bet}::numeric,'gain',${gain}::numeric,'combination',${outcome.combination}::text))`;
      return {dice,combination:outcome.combination,description:outcome.description,bet,gain,netResult:net,finalCash:n(updated[0].cash),tokensLeft:Number(updated[0].pari_tokens)};
    });
    return json(result);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/bonus/(status|redeem)$`));
  if(match){
    const actor=needUser(user),current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    if(match[2]==="status"&&method==="GET"){
      const remaining=secondsUntil(current.last_bonus_at,BONUS_COOLDOWN);
      return json({available:remaining===0,secondsUntilAvailable:remaining,rewardAmount:BONUS_REWARD,lastAdAt:iso(current.last_bonus_at)});
    }
    if(match[2]==="redeem"&&method==="POST"){
      const result=await sql.begin(async(tx:any)=>{
        const rows=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
        const remaining=secondsUntil(rows[0].last_bonus_at,BONUS_COOLDOWN);
        if(remaining>0) throw new ApiError(429,"Bonus en recharge",{secondsUntilAvailable:remaining});
        const updated=await tx`update heritier.players set cash=cash+${BONUS_REWARD},last_bonus_at=now() where id=${current.id}::uuid returning cash,last_bonus_at`;
        const netRows=await tx`select heritier.recalculate_player(${current.id}::uuid) as net`;
        return {ok:true,rewardAmount:BONUS_REWARD,cash:n(updated[0].cash),netWorth:n(netRows[0].net),secondsUntilNext:BONUS_COOLDOWN,lastAdAt:iso(updated[0].last_bonus_at)};
      });
      return json(result);
    }
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/drag/session$`));
  if(match&&method==="GET"){
    const actor=needUser(user),player=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    return json({player:mapPlayer(player),drag:{stage:Number(player.drag_stage),engineLevel:Number(player.drag_engine_level),transmissionLevel:Number(player.drag_transmission_level),tuning:{engineMax:1.6,nitroPowerMax:1.8,nitroChargesMax:3},cooldowns:{rewardCooldownSeconds:secondsUntil(player.drag_last_reward_at,5)}}});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/drag/result$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const stage=number(payload.stage,"Étape",{min:1,max:200,integer:true}),elapsed=number(payload.elapsedMs,"Temps",{min:1000,max:60000,integer:true}),perfect=number(payload.perfectShifts??0,"Changements parfaits",{min:0,max:8,integer:true});
    const win=payload.win===true; const minTime=Math.max(4000,5500-(stage-1)*50); fail(elapsed>=minTime,400,"Temps de course improbable");
    const result=await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      fail(stage<=Number(rows[0].drag_stage),400,"Étape non débloquée");
      if(rows[0].drag_last_run_at&&secondsUntil(rows[0].drag_last_run_at,1)>0) throw new ApiError(429,"Courses trop rapprochées");
      const granted=win&&secondsUntil(rows[0].drag_last_reward_at,5)===0?50000:0;
      await tx`insert into heritier.drag_runs(player_id,game_id,stage,elapsed_ms,win,perfect_shifts,reward,granted_reward,device_info) values(${current.id}::uuid,${match![1]}::uuid,${stage},${elapsed},${win},${perfect},${number(payload.reward??0,"Récompense annoncée",{min:0,max:1000000})},${granted},${JSON.stringify({device:payload.device??null,tuning:payload.tuning??null})}::jsonb)`;
      const nextStage=win&&stage>=Number(rows[0].drag_stage)?Number(rows[0].drag_stage)+1:Number(rows[0].drag_stage);
      const updated=await tx`update heritier.players set cash=cash+${granted},drag_stage=${nextStage},drag_last_run_at=now(),drag_last_reward_at=case when ${granted}>0 then now() else drag_last_reward_at end,drag_best_time_ms=least(coalesce(drag_best_time_ms,${elapsed}),${elapsed}) where id=${current.id}::uuid returning *`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`;
      return {ok:true,grantedReward:granted,player:{cash:n(updated[0].cash),netWorth:n(updated[0].net_worth)+granted},drag:{stage:nextStage},cooldowns:{rewardCooldownSeconds:5}};
    });
    return json(result);
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/drag/history$`));
  if(match&&method==="GET"){
    const actor=needUser(user),current=await playerFor(actor,match[1],req.headers.get("x-player-id")); const limit=number(url.searchParams.get("limit")??20,"Limite",{min:1,max:100,integer:true});
    const rows=await sql`select * from heritier.drag_runs where game_id=${match[1]}::uuid and player_id=${current.id}::uuid order by created_at desc limit ${limit}`;
    return json({history:rows.map((row:any)=>({stage:Number(row.stage),elapsedMs:Number(row.elapsed_ms),win:Boolean(row.win),perfectShifts:Number(row.perfect_shifts),grantedReward:n(row.granted_reward),createdAt:iso(row.created_at)}))});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/drag/opponents$`));
  if(match&&method==="GET"){
    const actor=needUser(user),current=await playerFor(actor,match[1],req.headers.get("x-player-id")); const limit=number(url.searchParams.get("limit")??50,"Limite",{min:1,max:200,integer:true});
    const rows=await sql`
      select p.id as player_id,p.nickname,p.drag_engine_level,p.drag_transmission_level,min(r.elapsed_ms) as best_ms,max(r.created_at) as last_at
      from heritier.players p join heritier.drag_runs r on r.player_id=p.id and r.game_id=p.game_id
      where p.game_id=${match[1]}::uuid and p.id<>${current.id}::uuid
      group by p.id order by best_ms asc limit ${limit}
    `;
    return json({opponents:rows.map((row:any)=>({playerId:row.player_id,nickname:row.nickname,bestMs:Number(row.best_ms),lastAt:iso(row.last_at),engineLevel:Number(row.drag_engine_level),transmissionLevel:Number(row.drag_transmission_level)}))});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/drag/upgrade/(engine|transmission)$`));
  if(match&&method==="POST"){
    const actor=needUser(user),current=await playerFor(actor,match[1],req.headers.get("x-player-id")),type=match[2];
    const updated=await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.players where id=${current.id}::uuid for update`; fail(n(rows[0].cash)>=1000000,400,"Fonds insuffisants");
      const level=type==="engine"?Number(rows[0].drag_engine_level):Number(rows[0].drag_transmission_level),max=type==="engine"?20:5; fail(level<max,400,`${type==="engine"?"Moteur":"Transmission"} déjà au niveau maximum`);
      return type==="engine"
        ? (await tx`update heritier.players set cash=cash-1000000,drag_engine_level=drag_engine_level+1 where id=${current.id}::uuid returning *`)[0]
        : (await tx`update heritier.players set cash=cash-1000000,drag_transmission_level=drag_transmission_level+1 where id=${current.id}::uuid returning *`)[0];
    });
    return json({ok:true,player:{cash:n(updated.cash)},drag:{engineLevel:Number(updated.drag_engine_level),transmissionLevel:Number(updated.drag_transmission_level)}});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/referrals/create$`));
  if(match&&method==="POST"){
    const actor=needUser(user),current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const code=crypto.randomUUID().replaceAll("-","").slice(0,10); const rows=await sql`insert into heritier.referral_invites(game_id,inviter_id,code) values(${match[1]}::uuid,${current.id}::uuid,${code}) returning *`;
    const origin=req.headers.get("origin")??"https://client-jeux-millionnaire.vercel.app";
    return json({code,url:`${origin.replace(/\/$/,"")}/?invite=${code}`,reward:n(rows[0].reward_amount)});
  }

  match=path.match(new RegExp(`^/api/games/(${UUID})/referrals/accept$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),code=string(payload.code,"Code",{min:6,max:40}),current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const result=await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.referral_invites where code=${code} and game_id=${match![1]}::uuid for update`;
      fail(rows[0],404,"Invitation invalide"); fail(rows[0].status==="pending",400,"Invitation déjà utilisée"); fail(rows[0].inviter_id!==current.id,400,"Vous ne pouvez pas accepter votre propre invitation");
      await tx`update heritier.referral_invites set status='accepted',accepted_by_id=${current.id}::uuid,accepted_at=now() where id=${rows[0].id}::uuid`;
      await tx`update heritier.players set cash=cash+${n(rows[0].reward_amount)} where id=${rows[0].inviter_id}::uuid`;
      await tx`select heritier.recalculate_player(${rows[0].inviter_id}::uuid)`;
      return {accepted:true,reward:n(rows[0].reward_amount)};
    });
    return json(result);
  }

  return null;
}
