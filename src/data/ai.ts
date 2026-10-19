// Client side of optional AI assistance. The Anthropic key lives only in the Supabase Edge
// Function; this module never sees it. Every response is validated and recomputed locally.

import { aiContext, reviewSuggestion, validateAiResponse, type AiReview, type AiValidation } from '../domain/ai';
import { buildStockView, balances } from '../domain/stock';
import type { AppState, Workspace } from '../domain/types';
import type { Repository } from './repository';
import { SupabaseRepository } from './live';

export type AiMode = 'make_now' | 'special' | 'one_two_away';

export function aiAvailability(repo: Repository): { available: boolean; reason: string } {
  if (!(repo instanceof SupabaseRepository)) {
    return { available: false, reason: 'AI suggestions run through a server function and need a connected Supabase project with an Anthropic key. Demo mode works fully without AI.' };
  }
  if (import.meta.env.VITE_AI_ENABLED !== 'true') {
    return { available: false, reason: 'AI is not enabled for this deployment (set VITE_AI_ENABLED=true after deploying the ai-assist function with ANTHROPIC_API_KEY).' };
  }
  return { available: true, reason: '' };
}

export interface AiRunResult {
  validation: AiValidation;
  reviews: AiReview[];
  model: string;
}

export async function requestAiSuggestions(repo: Repository, state: AppState, workspace: Workspace, plannedDate: string, mode: AiMode, note: string): Promise<AiRunResult> {
  if (!(repo instanceof SupabaseRepository)) throw new Error('AI is unavailable in demo mode');
  const view = buildStockView(state, { workspace, plannedDate, protectMenu: true });
  const free = new Map<string, number>();
  for (const b of balances(view)) free.set(b.ingredientId, (free.get(b.ingredientId) ?? 0) + b.freeForSpecials);
  const context = aiContext(state, workspace, plannedDate, free);
  const { data, error } = await repo.client.functions.invoke('ai-assist', {
    body: { orgId: state.org.id, mode, note: note.slice(0, 500), context },
  });
  if (error) throw new Error(error.message || 'AI request failed');
  const payload = data as { result?: unknown; model?: string; error?: string };
  if (payload.error) throw new Error(payload.error);
  const validation = validateAiResponse(payload.result, state, workspace);
  const model = payload.model ?? 'unknown model';
  const reviews = validation.suggestions.map((s) => reviewSuggestion(state, s, workspace, plannedDate, mode, model));
  return { validation, reviews, model };
}
