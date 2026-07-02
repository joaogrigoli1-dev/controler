"use client";
/**
 * noc.ts — camada de dados do NOC (FASE 4).
 *
 * Responsabilidades (achado B-04 + gate de UX da Fase 4):
 *  1. TIMEOUT em todo fetch (AbortController; default 10s).
 *  2. Validação Zod de toda resposta (schemas.ts) — resposta inválida vira erro
 *     visível, nunca dado corrompido silencioso.
 *  3. Fallback MOCK rotulado quando o endpoint da FASE 3 ainda não existe
 *     (404/501) — o UI mostra badge "MOCK", nunca finge dado real.
 *  4. Semântica STALE: erro de refresh com dado anterior em mãos → o dado
 *     continua na tela, marcado como desatualizado (regra "nunca fingir verde").
 */
import useSWR from "swr";
import type { z } from "zod";
import { ApiError, apiFetch } from "./api";

export type NocSource = "live" | "mock";

export interface NocEnvelope<T> {
  data: T;
  source: NocSource;
  fetchedAt: number;
}

export class NocValidationError extends Error {
  constructor(public path: string, public issues: unknown) {
    super(`Resposta inesperada do servidor em ${path}. A equipe já pode ver os detalhes no console.`);
    this.name = "NocValidationError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface NocFetchOpts<T> {
  /** Timeout do fetch (B-04). */
  timeoutMs?: number;
  /** Mock rotulado usado se o endpoint retornar 404/501 (coletor FASE 3 pendente). */
  mock?: () => T;
  method?: string;
  body?: unknown;
  otp?: string;
}

/** Fetch validado: apiFetch (auth/refresh/erros amigáveis) + timeout + Zod + fallback mock. */
export async function nocFetch<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  opts: NocFetchOpts<z.infer<S>> = {}
): Promise<NocEnvelope<z.infer<S>>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const raw = await apiFetch(path, {
      signal: ctrl.signal,
      method: opts.method,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      otp: opts.otp
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[noc] payload inválido em ${path}:`, parsed.error.issues.slice(0, 5));
      throw new NocValidationError(path, parsed.error.issues);
    }
    return { data: parsed.data, source: "live", fetchedAt: Date.now() };
  } catch (err) {
    // Endpoint da FASE 3 ainda não implementado → mock rotulado (gate: "dados reais/mocks")
    if (opts.mock && err instanceof ApiError && (err.status === 404 || err.status === 501)) {
      return { data: opts.mock(), source: "mock", fetchedAt: Date.now() };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface NocState<T> {
  data: T | undefined;
  source: NocSource | undefined;
  fetchedAt: number | undefined;
  error: Error | undefined;
  isLoading: boolean;
  /** true = temos dado, mas o último refresh falhou (exibir StaleOverlay/badge). */
  stale: boolean;
  refresh: () => void;
}

/** SWR + envelope NOC. `key` deve ser única por tela+recurso. */
export function useNoc<T>(
  key: string | null,
  fetcher: () => Promise<NocEnvelope<T>>,
  refreshMs?: number
): NocState<T> {
  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    refreshInterval: refreshMs,
    revalidateOnFocus: false,
    keepPreviousData: true,
    shouldRetryOnError: true,
    errorRetryCount: 3
  });
  return {
    data: data?.data,
    source: data?.source,
    fetchedAt: data?.fetchedAt,
    error: error as Error | undefined,
    isLoading,
    stale: Boolean(error && data),
    refresh: () => void mutate()
  };
}
