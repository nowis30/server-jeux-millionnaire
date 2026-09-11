import {
  ApiError,
  type AuthUser,
  body,
  fail,
  iso,
  json,
  mapHolding,
  mapPlayer,
  mapTemplate,
  n,
  number,
  playerFor,
  requireAdmin,
  sql,
  touchPresence,
  weeklyMortgage,
} from "./lib.ts";

const UUID = "[0-9a-fA-F-]{36}";
const SYMBOLS = new Set(["SP500", "QQQ", "TSX", "GLD", "TLT"]);

function needUser(user: AuthUser | null): AuthUser {
  if (!user) throw new ApiError(401, "Connexion requise");
  return user;
}

function gamePayload(row: any): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    players: Number(row.players ?? 0),
    createdAt: iso(row.created_at),
  };
}

async function recalc(playerId: string, db: any = sql): Promise<void> {
  await db`select heritier.recalculate_player(${playerId}::uuid)`;
}

export async function handleCore(req: Request, url: URL, path: string, user: AuthUser | null): Promise<Response | null> {
  const method = req.method.toUpperCase();

  if (path === "/api/games" && method === "GET") {
    needUser(user);
    const rows = await sql`
      select g.*, count(p.id)::integer as players
      from heritier.games g
      left join heritier.players p on p.game_id = g.id
      where g.code = 'GLOBAL'
      group by g.id
      order by g.created_at asc
    `;
    return json({ games: rows.map(gamePayload) });
  }

  if (path === "/api/games" && method === "POST") {
    const actor = needUser(user);
    const rows = await sql`
      insert into heritier.games(code, status, started_at)
      values ('GLOBAL', 'running', now())
      on conflict (code) do update set status = 'running', started_at = coalesce(heritier.games.started_at, now())
      returning *
    `;
    const game = rows[0];
    const joined = await joinGame(actor, game.id);
    return json({ id: game.id, code: game.code, status: game.status, playerId: joined.id });
  }

  let match = path.match(new RegExp(`^/api/games/(${UUID})/join$`));
  if (match && method === "POST") {
    const actor = needUser(user);
    const player = await joinGame(actor, match[1]);
    const games = await sql`select code from heritier.games where id = ${match[1]}::uuid`;
    return json({ playerId: player.id, gameId: match[1], code: games[0]?.code ?? "GLOBAL" });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/presence$`));
  if (match && method === "POST") {
    const actor = needUser(user);
    const player = await playerFor(actor, match[1], req.headers.get("x-player-id"));
    await touchPresence(actor, match[1], player);
    return json({ ok: true, at: new Date().toISOString() });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/online$`));
  if (match && method === "GET") {
    const actor = needUser(user);
    const playerRows = await sql`select * from heritier.players where game_id = ${match[1]}::uuid and auth_user_id = ${actor.id}::uuid limit 1`;
    if (playerRows[0]) await touchPresence(actor, match[1], playerRows[0]);
    const rows = await sql`
      select nickname from heritier.presence
      where game_id = ${match[1]}::uuid and last_seen_at >= now() - interval '90 seconds'
      order by nickname
    `;
    return json({ gameId: match[1], online: rows.length, users: rows.map((row: any) => row.nickname) });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/events$`));
  if (match && method === "GET") {
    needUser(user);
    const after = Math.max(0, Math.floor(Number(url.searchParams.get("after") ?? 0)) || 0);
    const rows = await sql`
      select id, player_id, type, payload, created_at
      from heritier.event_feed
      where game_id = ${match[1]}::uuid and id > ${after}
      order by id asc limit 100
    `;
    return json({ events: rows.map((row: any) => ({ id: Number(row.id), playerId: row.player_id, type: row.type, at: iso(row.created_at), ...(row.payload ?? {}) })) });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/state$`));
  if (match && method === "GET") {
    needUser(user);
    const games = await sql`select * from heritier.games where id = ${match[1]}::uuid`;
    fail(games[0], 404, "Partie introuvable");
    const players = await sql`select * from heritier.players where game_id = ${match[1]}::uuid order by net_worth desc`;
    return json({ id: games[0].id, code: games[0].code, status: games[0].status, players: players.map(mapPlayer) });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/summary$`));
  if (match && method === "GET") {
    needUser(user);
    const games = await sql`select * from heritier.games where id = ${match[1]}::uuid`;
    fail(games[0], 404, "Partie introuvable");
    const players = await sql`select id as player_id, nickname, net_worth from heritier.players where game_id = ${match[1]}::uuid order by net_worth desc`;
    const leaderboard = players.map((row: any) => ({ playerId: row.player_id, nickname: row.nickname, netWorth: n(row.net_worth) }));
    return json({ status: games[0].status, winner: leaderboard[0] ?? null, leaderboard });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/me$`));
  if (match && method === "GET") {
    const actor = needUser(user);
    const player = await playerFor(actor, match[1], req.headers.get("x-player-id"));
    await touchPresence(actor, match[1], player);
    return json({ player: mapPlayer(player) });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/start$`));
  if (match && method === "POST") {
    const actor = needUser(user); requireAdmin(actor);
    const rows = await sql`update heritier.games set status='running', started_at=coalesce(started_at, now()) where id=${match[1]}::uuid returning *`;
    fail(rows[0], 404, "Partie introuvable");
    return json({ id: rows[0].id, status: rows[0].status });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/advance-weeks$`));
  if (match && method === "POST") {
    const actor = needUser(user); requireAdmin(actor);
    const weeks = number(url.searchParams.get("weeks") ?? 4, "Nombre de semaines", { min: 1, max: 520, integer: true });
    const started = Date.now();
    for (let index = 0; index < weeks; index += 1) await sql`select heritier.hourly_tick()`;
    return json({ ok: true, gameId: match[1], weeksApplied: weeks, durationMs: Date.now() - started });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/restart$`));
  if (match && method === "POST") {
    const actor = needUser(user); requireAdmin(actor);
    const payload = await body(req);
    fail(payload.confirm === true, 400, "Confirmation requise");
    await sql.begin(async (tx: any) => {
      await tx`delete from heritier.event_feed where game_id=${match![1]}::uuid`;
      await tx`delete from heritier.market_ticks where game_id=${match![1]}::uuid`;
      await tx`delete from heritier.players where game_id=${match![1]}::uuid`;
      await tx`update heritier.games set status='running', started_at=now(), inflation_index=1, inflation_annual=0.01+random()*0.04 where id=${match![1]}::uuid`;
      await tx`
        insert into heritier.market_ticks(game_id, symbol, price)
        select ${match![1]}::uuid, symbol, price
        from (values ('SP500',5000::numeric),('QQQ',450::numeric),('TSX',21000::numeric),('GLD',190::numeric),('TLT',90::numeric)) seed(symbol,price)
      `;
    });
    return json({ id: match[1], status: "running", restartedAt: new Date().toISOString() });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/players/(${UUID})$`));
  if (match && method === "DELETE") {
    const actor = needUser(user); requireAdmin(actor);
    const rows = await sql`delete from heritier.players where id=${match[2]}::uuid and game_id=${match[1]}::uuid returning id`;
    fail(rows[0], 404, "Joueur introuvable");
    return json({ deleted: true, playerId: match[2] });
  }

  if (path === "/api/properties/templates" && method === "GET") {
    const gameId = url.searchParams.get("gameId");
    const rows = gameId
      ? await sql`
          select t.* from heritier.property_templates t
          where t.active and not exists (
            select 1 from heritier.property_holdings h
            where h.game_id=${gameId}::uuid and h.template_id=t.id
          ) order by t.price asc
        `
      : await sql`select * from heritier.property_templates where active order by price asc`;
    return json({ templates: rows.map(mapTemplate) });
  }

  match = path.match(new RegExp(`^/api/properties/templates/(${UUID})$`));
  if (match && method === "GET") {
    const rows = await sql`select * from heritier.property_templates where id=${match[1]}::uuid and active`;
    fail(rows[0], 404, "Immeuble introuvable");
    return json({ template: mapTemplate(rows[0]) });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/holdings/(${UUID})$`));
  if (match && method === "GET") {
    needUser(user);
    const rows = await sql`
      select h.*, row_to_json(t.*) as template
      from heritier.property_holdings h
      join heritier.property_templates t on t.id=h.template_id
      where h.game_id=${match[1]}::uuid and h.player_id=${match[2]}::uuid
      order by h.created_at desc
    `;
    return json({ holdings: rows.map((row: any) => mapHolding(row, row.template)) });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/owner/(${UUID})$`));
  if (match && method === "GET") {
    needUser(user);
    const rows = await sql`
      select p.nickname from heritier.property_holdings h
      join heritier.players p on p.id=h.player_id
      where h.game_id=${match[1]}::uuid and h.template_id=${match[2]}::uuid limit 1
    `;
    return json({ ownerNickname: rows[0]?.nickname ?? null });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/bilan/(${UUID})$`));
  if (match && method === "GET") {
    needUser(user);
    const rows = await sql`
      select h.*, t.name as template_name from heritier.property_holdings h
      join heritier.property_templates t on t.id=h.template_id
      where h.id=${match[2]}::uuid and h.game_id=${match[1]}::uuid
    `;
    fail(rows[0], 404, "Bien introuvable");
    const row = rows[0];
    const logs = await sql`select at,amount,rate from heritier.refinance_logs where holding_id=${match[2]}::uuid order by at`;
    return json({ bilan: {
      holdingId: row.id, templateName: row.template_name, purchasePrice: n(row.purchase_price),
      downPayment: n(row.down_payment), initialMortgageDebt: n(row.initial_mortgage_debt),
      currentMortgageDebt: n(row.mortgage_debt), mortgageRate: n(row.mortgage_rate),
      termYears: Number(row.term_years), weeksElapsed: Number(row.weeks_elapsed),
      currentValue: n(row.current_value), currentRent: n(row.current_rent),
      accumulated: { rent:n(row.accumulated_rent), interest:n(row.accumulated_interest_paid), taxes:n(row.accumulated_taxes_paid), insurance:n(row.accumulated_insurance_paid), maintenance:n(row.accumulated_maintenance_paid), netCashflow:n(row.accumulated_net_cashflow) },
      refinanceEvents: logs.map((log: any) => ({ at: iso(log.at), amount:n(log.amount), rate:n(log.rate) })),
    } });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/players/(${UUID})/portfolio$`));
  if (match && method === "GET") {
    needUser(user);
    const holdings = await sql`
      select h.*, t.taxes, t.insurance, t.maintenance
      from heritier.property_holdings h join heritier.property_templates t on t.id=h.template_id
      where h.game_id=${match[1]}::uuid and h.player_id=${match[2]}::uuid
    `;
    const players = await sql`select * from heritier.players where id=${match[2]}::uuid and game_id=${match[1]}::uuid`;
    fail(players[0], 404, "Joueur introuvable");
    let totalValue=0,totalDebt=0,weeklyRent=0,weeklyDebt=0,weeklyFixed=0,accumulatedNet=0;
    for (const holding of holdings) {
      totalValue += n(holding.current_value); totalDebt += n(holding.mortgage_debt);
      weeklyRent += n(holding.current_rent); weeklyDebt += n(holding.weekly_payment);
      weeklyFixed += (n(holding.taxes)+n(holding.insurance)+n(holding.maintenance))/52;
      accumulatedNet += n(holding.accumulated_net_cashflow);
    }
    const weeklyNet=weeklyRent-weeklyDebt-weeklyFixed;
    return json({
      cash: n(players[0].cash),
      totals: { totalValue,totalDebt,weeklyRent,weeklyDebt,weeklyFixed,weeklyNet,monthlyRent:weeklyRent*52/12,monthlyDebt:weeklyDebt*52/12,monthlyFixed:weeklyFixed*52/12,monthlyNet:weeklyNet*52/12,accumulatedNet,holdingsCount:holdings.length,cash:n(players[0].cash),netWorth:n(players[0].net_worth) },
      playerGains: { cumulativePariGain:n(players[0].cumulative_pari_gain), cumulativeQuizGain:n(players[0].cumulative_quiz_gain), cumulativeMarketRealized:n(players[0].cumulative_market_realized), cumulativeMarketDividends:n(players[0].cumulative_market_dividends) },
    });
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/purchase$`));
  if (match && method === "POST") {
    const actor = needUser(user); const payload = await body(req);
    const current = await playerFor(actor, match[1], String(payload.playerId ?? req.headers.get("x-player-id") ?? ""));
    const templateId = String(payload.templateId ?? "");
    const downRaw = number(payload.downPaymentPercent ?? 20, "Mise de fonds", { min: 0.2, max: 100 });
    const downFraction = Math.max(0.2, Math.min(1, downRaw > 1 ? downRaw/100 : downRaw));
    const rate = number(payload.mortgageRate ?? 0.05, "Taux", { min: 0, max: 0.15 });
    const term = number(payload.mortgageYears ?? 25, "Amortissement", { min: 5, max: 25, integer: true });
    const created = await sql.begin(async (tx: any) => {
      const players = await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      const templates = await tx`select * from heritier.property_templates where id=${templateId}::uuid and active`;
      fail(templates[0], 404, "Immeuble introuvable");
      const owned = await tx`select p.nickname from heritier.property_holdings h join heritier.players p on p.id=h.player_id where h.game_id=${match![1]}::uuid and h.template_id=${templateId}::uuid`;
      if (owned[0]) throw new ApiError(409, `Immeuble déjà vendu à '${owned[0].nickname}'`);
      const price=n(templates[0].price), down=Math.round(price*downFraction*100)/100, debt=price-down;
      fail(n(players[0].cash)>=down,400,"Liquidités insuffisantes");
      const payment=weeklyMortgage(debt,rate,term);
      await tx`update heritier.players set cash=cash-${down} where id=${current.id}::uuid`;
      const rows=await tx`
        insert into heritier.property_holdings(game_id,player_id,template_id,purchase_price,down_payment,initial_mortgage_debt,current_value,current_rent,mortgage_rate,mortgage_debt,weekly_payment,term_years)
        values (${match![1]}::uuid,${current.id}::uuid,${templateId}::uuid,${price},${down},${debt},${price},${n(templates[0].base_rent)*Number(templates[0].units)},${rate},${debt},${payment},${term}) returning *
      `;
      await tx`select heritier.record_event(${match![1]}::uuid,${current.id}::uuid,'property:purchase',jsonb_build_object('holdingId',${rows[0].id}::text,'templateId',${templateId}::text))`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`;
      return rows[0];
    });
    return json({ holdingId: created.id }, 201);
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/(${UUID})/repay$`));
  if (match && method === "POST") {
    const actor=needUser(user), payload=await body(req), amount=number(payload.amount,"Montant",{min:0.01});
    const current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const result=await sql.begin(async (tx:any)=>{
      const holdings=await tx`select * from heritier.property_holdings where id=${match![2]}::uuid and game_id=${match![1]}::uuid for update`;
      fail(holdings[0],404,"Bien introuvable"); fail(holdings[0].player_id===current.id,403,"Vous n’êtes pas propriétaire de ce bien");
      const players=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      const applied=Math.min(amount,n(players[0].cash),n(holdings[0].mortgage_debt)); fail(applied>0,400,"Fonds insuffisants ou dette nulle");
      const debt=Math.max(0,n(holdings[0].mortgage_debt)-applied);
      await tx`update heritier.property_holdings set mortgage_debt=${debt} where id=${match![2]}::uuid`;
      const updated=await tx`update heritier.players set cash=cash-${applied} where id=${current.id}::uuid returning cash`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`;
      return {applied,newDebt:debt,playerCash:n(updated[0].cash)};
    });
    return json(result);
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/(${UUID})/refinance$`));
  if (match && method === "POST") {
    const actor=needUser(user), payload=await body(req);
    const current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const rate=number(payload.newRate,"Nouveau taux",{min:0,max:0.15});
    const term=number(payload.newTermYears ?? 25,"Nouvelle durée",{min:5,max:25,integer:true});
    const cashOut=number(payload.cashOutPercent ?? 0,"Retrait",{min:0,max:1});
    await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.property_holdings where id=${match![2]}::uuid and game_id=${match![1]}::uuid for update`;
      fail(rows[0],404,"Bien introuvable"); fail(rows[0].player_id===current.id,403,"Vous n’êtes pas propriétaire de ce bien");
      const oldDebt=n(rows[0].mortgage_debt), target=Math.min(n(rows[0].current_value)*0.8,oldDebt*(1+cashOut)), delta=Math.max(0,target-oldDebt);
      const payment=weeklyMortgage(target,rate,term);
      await tx`update heritier.property_holdings set mortgage_rate=${rate},mortgage_debt=${target},weekly_payment=${payment},term_years=${term},weeks_elapsed=0 where id=${match![2]}::uuid`;
      await tx`insert into heritier.refinance_logs(holding_id,amount,rate) values (${match![2]}::uuid,${delta},${rate})`;
      if(delta>0) await tx`update heritier.players set cash=cash+${delta} where id=${current.id}::uuid`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`;
    });
    return json({status:"ok"});
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/properties/(${UUID})/sell$`));
  if (match && method === "POST") {
    const actor=needUser(user), current=await playerFor(actor,match[1],req.headers.get("x-player-id"));
    const proceeds=await sql.begin(async(tx:any)=>{
      const rows=await tx`select * from heritier.property_holdings where id=${match![2]}::uuid and game_id=${match![1]}::uuid for update`;
      fail(rows[0],404,"Bien introuvable"); fail(rows[0].player_id===current.id,403,"Vous n’êtes pas propriétaire de ce bien");
      const value=n(rows[0].current_value)-n(rows[0].mortgage_debt);
      await tx`delete from heritier.property_holdings where id=${match![2]}::uuid`;
      await tx`update heritier.players set cash=cash+${value} where id=${current.id}::uuid`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`;
      return value;
    });
    return json({proceeds});
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/markets/latest$`));
  if (match && method === "GET") {
    needUser(user);
    const rows=await sql`select distinct on(symbol) symbol,price,at from heritier.market_ticks where game_id=${match[1]}::uuid order by symbol,at desc`;
    return json({prices:rows.map((row:any)=>({symbol:row.symbol,price:n(row.price),at:iso(row.at)}))});
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/markets/history/([A-Z0-9]+)$`));
  if(match&&method==="GET"){
    needUser(user); fail(SYMBOLS.has(match[2]),400,"Actif inconnu");
    const years=number(url.searchParams.get("years")??10,"Période",{min:1,max:50});
    const rows=await sql`select at,price from heritier.market_ticks where game_id=${match[1]}::uuid and symbol=${match[2]} and at>=now()-(${years}::text||' years')::interval order by at asc limit 1500`;
    return json({symbol:match[2],data:rows.map((row:any)=>({at:iso(row.at),price:n(row.price)}))});
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/markets/holdings/(${UUID})$`));
  if(match&&method==="GET"){
    needUser(user); const rows=await sql`select * from heritier.market_holdings where game_id=${match[1]}::uuid and player_id=${match[2]}::uuid order by symbol`;
    return json({holdings:rows.map((row:any)=>({id:row.id,symbol:row.symbol,quantity:n(row.quantity),avgPrice:n(row.avg_price)}))});
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/markets/dividends/(${UUID})$`));
  if(match&&method==="GET"){
    needUser(user); const rows=await sql`
      select coalesce(sum(amount) filter(where at>=now()-interval '24 hours'),0) as d24,
             coalesce(sum(amount) filter(where at>=now()-interval '7 days'),0) as d7,
             coalesce(sum(amount) filter(where at>=date_trunc('year',now())),0) as ytd
      from heritier.dividend_logs where game_id=${match[1]}::uuid and player_id=${match[2]}::uuid
    `;
    return json({totals:{"24h":n(rows[0].d24),"7d":n(rows[0].d7),ytd:n(rows[0].ytd)},asOf:new Date().toISOString()});
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/markets/(buy|sell)$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),symbol=String(payload.symbol??"").toUpperCase(); fail(SYMBOLS.has(symbol),400,"Actif inconnu");
    const qty=number(payload.quantity,"Quantité",{min:0.000001,max:100000000});
    const current=await playerFor(actor,match[1],String(payload.playerId??req.headers.get("x-player-id")??""));
    const action=match[2];
    const result=await sql.begin(async(tx:any)=>{
      const players=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      const prices=await tx`select price from heritier.market_ticks where game_id=${match![1]}::uuid and symbol=${symbol} order by at desc limit 1`;
      fail(prices[0],503,"Cours indisponible"); const price=n(prices[0].price);
      const positions=await tx`select * from heritier.market_holdings where game_id=${match![1]}::uuid and player_id=${current.id}::uuid and symbol=${symbol} for update`;
      if(action==="buy"){
        const cost=price*qty; fail(n(players[0].cash)>=cost,400,"Encaisse insuffisante");
        const oldQty=n(positions[0]?.quantity),nextQty=oldQty+qty,avg=positions[0]?(oldQty*n(positions[0].avg_price)+cost)/nextQty:price;
        await tx`update heritier.players set cash=cash-${cost} where id=${current.id}::uuid`;
        await tx`insert into heritier.market_holdings(game_id,player_id,symbol,quantity,avg_price) values(${match![1]}::uuid,${current.id}::uuid,${symbol},${nextQty},${avg}) on conflict(game_id,player_id,symbol) do update set quantity=excluded.quantity,avg_price=excluded.avg_price`;
        await tx`select heritier.record_event(${match![1]}::uuid,${current.id}::uuid,'market:buy',jsonb_build_object('symbol',${symbol}::text,'quantity',${qty}::numeric,'price',${price}::numeric))`;
        await tx`select heritier.recalculate_player(${current.id}::uuid)`; return {status:"ok",price,cost,quantity:nextQty};
      }
      fail(positions[0]&&n(positions[0].quantity)>=qty,400,"Position insuffisante");
      const proceeds=price*qty,remaining=n(positions[0].quantity)-qty,realized=(price-n(positions[0].avg_price))*qty;
      await tx`update heritier.players set cash=cash+${proceeds},cumulative_market_realized=cumulative_market_realized+${realized} where id=${current.id}::uuid`;
      if(remaining<=0.0000001) await tx`delete from heritier.market_holdings where id=${positions[0].id}::uuid`;
      else await tx`update heritier.market_holdings set quantity=${remaining} where id=${positions[0].id}::uuid`;
      await tx`select heritier.record_event(${match![1]}::uuid,${current.id}::uuid,'market:sell',jsonb_build_object('symbol',${symbol}::text,'quantity',${qty}::numeric,'price',${price}::numeric))`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`; return {status:"ok",price,proceeds,remaining};
    });
    return json(result);
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/listings$`));
  if(match&&method==="GET"){
    needUser(user); const rows=await sql`
      select l.*, row_to_json(h.*) as holding, row_to_json(t.*) as template
      from heritier.listings l join heritier.property_holdings h on h.id=l.holding_id join heritier.property_templates t on t.id=l.template_id
      where l.game_id=${match[1]}::uuid order by l.created_at desc
    `;
    return json({listings:rows.map((row:any)=>({id:row.id,gameId:row.game_id,holdingId:row.holding_id,templateId:row.template_id,sellerId:row.seller_id,price:n(row.price),type:row.type,createdAt:iso(row.created_at),holding:mapHolding(row.holding,row.template),template:mapTemplate(row.template)}))});
  }
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),current=await playerFor(actor,match[1],String(payload.sellerId??req.headers.get("x-player-id")??""));
    const holdingId=String(payload.holdingId??""),price=number(payload.price,"Prix",{min:1});
    const holdings=await sql`select * from heritier.property_holdings where id=${holdingId}::uuid and game_id=${match[1]}::uuid`;
    fail(holdings[0],404,"Bien introuvable"); fail(holdings[0].player_id===current.id,403,"Vous n’êtes pas propriétaire de ce bien");
    const rows=await sql`insert into heritier.listings(game_id,holding_id,template_id,seller_id,price) values(${match[1]}::uuid,${holdingId}::uuid,${holdings[0].template_id}::uuid,${current.id}::uuid,${price}) returning *`;
    await sql`select heritier.record_event(${match[1]}::uuid,${current.id}::uuid,'listing:create',jsonb_build_object('listingId',${rows[0].id}::text))`;
    return json({listing:{id:rows[0].id,price:n(rows[0].price)}},201);
  }

  match = path.match(new RegExp(`^/api/games/(${UUID})/listings/(${UUID})/(cancel|accept)$`));
  if(match&&method==="POST"){
    const actor=needUser(user),payload=await body(req),current=await playerFor(actor,match[1],String(payload[match[3]==="cancel"?"sellerId":"buyerId"]??req.headers.get("x-player-id")??""));
    if(match[3]==="cancel"){
      const rows=await sql`delete from heritier.listings where id=${match[2]}::uuid and game_id=${match[1]}::uuid and seller_id=${current.id}::uuid returning id`;
      fail(rows[0],404,"Annonce introuvable ou non autorisée");
      await sql`select heritier.record_event(${match[1]}::uuid,${current.id}::uuid,'listing:cancel',jsonb_build_object('listingId',${match[2]}::text))`;
      return json({status:"ok"});
    }
    const result=await sql.begin(async(tx:any)=>{
      const listings=await tx`select * from heritier.listings where id=${match![2]}::uuid and game_id=${match![1]}::uuid for update`;
      fail(listings[0],404,"Annonce introuvable"); fail(listings[0].seller_id!==current.id,400,"Vous ne pouvez pas acheter votre propre annonce");
      const buyers=await tx`select * from heritier.players where id=${current.id}::uuid for update`;
      const sellers=await tx`select * from heritier.players where id=${listings[0].seller_id}::uuid for update`;
      const price=n(listings[0].price); fail(n(buyers[0].cash)>=price,400,"Fonds insuffisants");
      const holdings=await tx`select * from heritier.property_holdings where id=${listings[0].holding_id}::uuid for update`; fail(holdings[0],409,"Bien déjà vendu");
      await tx`update heritier.players set cash=cash-${price} where id=${current.id}::uuid`;
      await tx`update heritier.players set cash=cash+${price} where id=${sellers[0].id}::uuid`;
      await tx`update heritier.property_holdings set player_id=${current.id}::uuid where id=${holdings[0].id}::uuid`;
      await tx`delete from heritier.listings where id=${match![2]}::uuid`;
      await tx`select heritier.recalculate_player(${current.id}::uuid)`; await tx`select heritier.recalculate_player(${sellers[0].id}::uuid)`;
      await tx`select heritier.record_event(${match![1]}::uuid,${current.id}::uuid,'listing:accept',jsonb_build_object('listingId',${match![2]}::text,'price',${price}::numeric))`;
      return {status:"ok",holdingId:holdings[0].id,price};
    });
    return json(result);
  }

  return null;
}

async function joinGame(user: AuthUser, gameId: string): Promise<any> {
  const games = await sql`select * from heritier.games where id=${gameId}::uuid`;
  fail(games[0], 404, "Partie introuvable");
  const nickname = user.email.toLowerCase();
  const rows = await sql`
    insert into heritier.players(game_id,auth_user_id,nickname)
    values(${gameId}::uuid,${user.id}::uuid,${nickname})
    on conflict(game_id,auth_user_id) do update set nickname=excluded.nickname
    returning *
  `;
  await touchPresence(user, gameId, rows[0]);
  try {
    await sql`select public.sync_external_game_economy(${user.id}::uuid,'heritier-millionnaire','hzyxrubwggcjueqkongh',${user.id}::uuid,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb)`;
  } catch (error) {
    console.warn("[heritier] central wallet link deferred", error instanceof Error ? error.message : String(error));
  }
  return rows[0];
}

