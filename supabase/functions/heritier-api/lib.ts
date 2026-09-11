import postgres from "npm:postgres@3.4.7";

const DB_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DB_URL) throw new Error("SUPABASE_DB_URL is required");

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hzyxrubwggcjueqkongh.supabase.co";
export const PUBLIC_KEY =
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ??
  "sb_publishable_03fRORDfOBFt7PO7RcNEEA_zA8_fQbO";

export const sql: any = postgres(DB_URL, {
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-player-id, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export type AuthUser = {
  id: string;
  email: string;
  isAdmin: boolean;
  accessToken: string;
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function fail(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new ApiError(status, message);
}

export function number(value: unknown, label: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ApiError(400, `${label} invalide`);
  if (options.integer && !Number.isInteger(parsed)) throw new ApiError(400, `${label} doit être un entier`);
  if (options.min != null && parsed < options.min) throw new ApiError(400, `${label} trop petit`);
  if (options.max != null && parsed > options.max) throw new ApiError(400, `${label} trop grand`);
  return parsed;
}

export function string(value: unknown, label: string, options: { min?: number; max?: number; pattern?: RegExp } = {}): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if ((options.min ?? 1) > parsed.length) throw new ApiError(400, `${label} requis`);
  if (options.max != null && parsed.length > options.max) throw new ApiError(400, `${label} trop long`);
  if (options.pattern && !options.pattern.test(parsed)) throw new ApiError(400, `${label} invalide`);
  return parsed;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Corps JSON invalide");
  }
}

export async function authenticate(req: Request): Promise<AuthUser> {
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "Connexion requise");
  const accessToken = match[1];

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: PUBLIC_KEY,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) throw new ApiError(401, "Session expirée. Veuillez vous reconnecter.");
  const auth = await response.json() as { id?: string; email?: string };
  if (!auth.id || !auth.email) throw new ApiError(401, "Compte invalide");

  const adminRows = await sql`select exists(select 1 from heritier.admins where user_id = ${auth.id}::uuid) as value`;
  return { id: auth.id, email: auth.email, isAdmin: Boolean(adminRows[0]?.value), accessToken };
}

export function requireAdmin(user: AuthUser): void {
  if (!user.isAdmin) throw new ApiError(403, "Accès administrateur requis");
}

export function normalizePath(url: URL): string {
  let path = url.pathname;
  const marker = "/heritier-api";
  const markerIndex = path.indexOf(marker);
  if (markerIndex >= 0) path = path.slice(markerIndex + marker.length);
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

export function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapPlayer(row: any): Record<string, unknown> {
  return {
    id: row.id,
    nickname: row.nickname,
    cash: n(row.cash),
    netWorth: n(row.net_worth),
    cumulativePariGain: n(row.cumulative_pari_gain),
    cumulativeQuizGain: n(row.cumulative_quiz_gain),
    cumulativeMarketRealized: n(row.cumulative_market_realized),
    cumulativeMarketDividends: n(row.cumulative_market_dividends),
    quizTokens: Number(row.quiz_tokens ?? 0),
    pariTokens: Number(row.pari_tokens ?? 0),
    dragStage: Number(row.drag_stage ?? 1),
    dragEngineLevel: Number(row.drag_engine_level ?? 1),
    dragTransmissionLevel: Number(row.drag_transmission_level ?? 1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapTemplate(row: any): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: n(row.price),
    baseRent: n(row.base_rent),
    taxes: n(row.taxes),
    insurance: n(row.insurance),
    maintenance: n(row.maintenance),
    units: Number(row.units ?? 1),
    city: row.city,
    address: row.address,
    province: row.province,
    postalCode: row.postal_code,
    yearBuilt: Number(row.year_built ?? 2000),
    surfaceArea: n(row.surface_area),
    landArea: n(row.land_area),
    imageUrl: row.image_url,
    plumbingState: row.plumbing_state,
    electricityState: row.electricity_state,
    roofState: row.roof_state,
    windowsState: row.windows_state,
    foundationState: row.foundation_state,
    interiorState: row.interior_state,
    exteriorState: row.exterior_state,
    floors: Number(row.floors ?? 1),
    hasCommercialCenter: Boolean(row.has_commercial_center),
  };
}

export function mapHolding(row: any, template?: any): Record<string, unknown> {
  return {
    id: row.id,
    gameId: row.game_id,
    playerId: row.player_id,
    templateId: row.template_id,
    purchasePrice: n(row.purchase_price),
    downPayment: n(row.down_payment),
    initialMortgageDebt: n(row.initial_mortgage_debt),
    currentValue: n(row.current_value),
    currentRent: n(row.current_rent),
    mortgageRate: n(row.mortgage_rate),
    mortgageDebt: n(row.mortgage_debt),
    weeklyPayment: n(row.weekly_payment),
    weeksElapsed: Number(row.weeks_elapsed ?? 0),
    termYears: Number(row.term_years ?? 25),
    accumulatedRent: n(row.accumulated_rent),
    accumulatedInterestPaid: n(row.accumulated_interest_paid),
    accumulatedTaxesPaid: n(row.accumulated_taxes_paid),
    accumulatedInsurancePaid: n(row.accumulated_insurance_paid),
    accumulatedMaintenancePaid: n(row.accumulated_maintenance_paid),
    accumulatedNetCashflow: n(row.accumulated_net_cashflow),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(template ? { template: mapTemplate(template) } : {}),
  };
}

export function mapQuestion(row: any): Record<string, unknown> {
  return {
    id: row.id,
    text: row.question,
    optionA: row.option_a,
    optionB: row.option_b,
    optionC: row.option_c,
    optionD: row.option_d,
    imageUrl: row.image_url,
  };
}

export async function playerFor(user: AuthUser, gameId: string, suppliedPlayerId?: string | null, db: any = sql): Promise<any> {
  const rows = await db`
    select * from heritier.players
    where game_id = ${gameId}::uuid and auth_user_id = ${user.id}::uuid
    limit 1
  `;
  const player = rows[0];
  if (!player) throw new ApiError(404, "Joueur non trouvé. Rejoignez d’abord la partie.");
  if (suppliedPlayerId && suppliedPlayerId !== player.id) throw new ApiError(403, "Ce profil joueur ne vous appartient pas");
  return player;
}

export async function touchPresence(user: AuthUser, gameId: string, player: any, db: any = sql): Promise<void> {
  await db`
    insert into heritier.presence(player_id, game_id, auth_user_id, nickname, last_seen_at)
    values (${player.id}::uuid, ${gameId}::uuid, ${user.id}::uuid, ${player.nickname}, now())
    on conflict (player_id) do update
      set game_id = excluded.game_id,
          auth_user_id = excluded.auth_user_id,
          nickname = excluded.nickname,
          last_seen_at = excluded.last_seen_at
  `;
}

export async function selectQuizQuestion(db: any, playerId: string, questionNumber: number, categories: string[] = []): Promise<any> {
  const difficulty = questionNumber <= 2 ? "easy" : questionNumber <= 5 ? "medium" : "hard";
  const normalizedCategories = categories.filter((value) => /^[a-z0-9-]{2,40}$/i.test(value)).slice(0, 20);
  let rows: any[];
  if (normalizedCategories.length) {
    rows = await db`
      select q.* from heritier.quiz_questions q
      where q.active and q.difficulty = ${difficulty}
        and q.category = any(${normalizedCategories}::text[])
        and not exists (
          select 1 from heritier.quiz_question_seen seen
          where seen.player_id = ${playerId}::uuid and seen.question_id = q.id
        )
      order by random() limit 1
    `;
  } else {
    rows = await db`
      select q.* from heritier.quiz_questions q
      where q.active and q.difficulty = ${difficulty}
        and not exists (
          select 1 from heritier.quiz_question_seen seen
          where seen.player_id = ${playerId}::uuid and seen.question_id = q.id
        )
      order by random() limit 1
    `;
  }
  if (!rows[0]) {
    rows = await db`select * from heritier.quiz_questions where active and difficulty = ${difficulty} order by random() limit 1`;
  }
  if (!rows[0]) throw new ApiError(503, "La banque de questions est momentanément vide");
  return rows[0];
}

export function quizPrize(questionNumber: number): number {
  return 50_000 * Math.pow(2, Math.max(0, questionNumber - 1));
}

export function weeklyMortgage(principal: number, annualRate: number, years: number): number {
  const weeks = Math.max(1, Math.round(years * 52));
  if (principal <= 0) return 0;
  const rate = annualRate / 52;
  if (rate <= 0) return principal / weeks;
  return (principal * rate) / (1 - Math.pow(1 + rate, -weeks));
}

export function secondsUntil(last: unknown, cooldownSeconds: number): number {
  if (!last) return 0;
  const elapsed = (Date.now() - new Date(String(last)).getTime()) / 1000;
  return Math.max(0, Math.ceil(cooldownSeconds - elapsed));
}

