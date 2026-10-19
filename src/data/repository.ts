// Repository boundary between the UI and persistence. The UI issues named commands; demo mode
// applies the pure domain ops to browser-local state, live mode calls Supabase RPCs.

import type { Clock } from '../domain/dates';
import type { commitInventoryImport, commitMenuImport, commitRecipeImport } from '../domain/imports';
import type * as ops from '../domain/ops';
import type { AppState, ShoppingList } from '../domain/types';

type Tail<F> = F extends (state: AppState, ctx: ops.OpCtx, ...rest: infer R) => unknown ? R : never;
type Result<F> = F extends (...args: never[]) => ops.OpResult<infer T> ? T : never;

export interface CommandMap {
  receiveLot: typeof ops.receiveLot;
  updateLotDetails: typeof ops.updateLotDetails;
  adjustLot: typeof ops.adjustLot;
  recordWaste: typeof ops.recordWaste;
  setLotStatus: typeof ops.setLotStatus;
  approveQualityReview: typeof ops.approveQualityReview;
  openLot: typeof ops.openLot;
  transferLot: typeof ops.transferLot;
  createPlan: typeof ops.createPlan;
  updatePlanDraft: typeof ops.updatePlanDraft;
  reservePlan: typeof ops.reservePlan;
  releasePlan: typeof ops.releasePlan;
  completePlan: typeof ops.completePlan;
  upsertMenuItem: typeof ops.upsertMenuItem;
  deleteMenuItem: typeof ops.deleteMenuItem;
  upsertProtection: typeof ops.upsertProtection;
  deleteProtection: typeof ops.deleteProtection;
  saveRecipe: typeof ops.saveRecipe;
  confirmRecipeVersion: typeof ops.confirmRecipeVersion;
  archiveRecipe: typeof ops.archiveRecipe;
  upsertIngredient: typeof ops.upsertIngredient;
  setStaple: typeof ops.setStaple;
  updateOrgSettings: typeof ops.updateOrgSettings;
  commitInventoryImport: typeof commitInventoryImport;
  commitRecipeImport: typeof commitRecipeImport;
  commitMenuImport: typeof commitMenuImport;
  saveShoppingList: (state: AppState, ctx: ops.OpCtx, list: Omit<ShoppingList, 'id' | 'orgId' | 'createdAt'>) => ops.OpResult<{ id: string }>;
}

export type Command = keyof CommandMap;
export type CommandArgs<K extends Command> = Tail<CommandMap[K]>;
export type CommandResult<K extends Command> = Result<CommandMap[K]>;

export interface Repository {
  readonly mode: 'demo' | 'live';
  readonly clock: Clock;
  load(): Promise<AppState>;
  run<K extends Command>(cmd: K, ...args: CommandArgs<K>): Promise<{ state: AppState; result: CommandResult<K>; replayed?: boolean }>;
}

export function idemKey(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return `${prefix}-${g.crypto?.randomUUID ? g.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
