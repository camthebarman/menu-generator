// Demo mode: persistent, isolated, browser-local data. Never syncs across devices.

import { systemClock, todayIn, type Clock } from '../domain/dates';
import { commitInventoryImport, commitMenuImport, commitRecipeImport } from '../domain/imports';
import * as ops from '../domain/ops';
import type { AppState, CurrentUser } from '../domain/types';
import { buildDemoState } from '../seed/demo';
import type { Command, CommandArgs, CommandMap, CommandResult, Repository } from './repository';

export const DEMO_STORAGE_KEY = 'tzml.demo.v1';
export const DEMO_SCHEMA_VERSION = 1;

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const COMMANDS: CommandMap = {
  receiveLot: ops.receiveLot,
  updateLotDetails: ops.updateLotDetails,
  adjustLot: ops.adjustLot,
  recordWaste: ops.recordWaste,
  setLotStatus: ops.setLotStatus,
  approveQualityReview: ops.approveQualityReview,
  openLot: ops.openLot,
  transferLot: ops.transferLot,
  createPlan: ops.createPlan,
  updatePlanDraft: ops.updatePlanDraft,
  reservePlan: ops.reservePlan,
  releasePlan: ops.releasePlan,
  completePlan: ops.completePlan,
  upsertMenuItem: ops.upsertMenuItem,
  deleteMenuItem: ops.deleteMenuItem,
  upsertProtection: ops.upsertProtection,
  deleteProtection: ops.deleteProtection,
  saveRecipe: ops.saveRecipe,
  confirmRecipeVersion: ops.confirmRecipeVersion,
  archiveRecipe: ops.archiveRecipe,
  upsertIngredient: ops.upsertIngredient,
  setStaple: ops.setStaple,
  updateOrgSettings: ops.updateOrgSettings,
  commitInventoryImport,
  commitRecipeImport,
  commitMenuImport,
  saveShoppingList: ops.saveShoppingList,
};

export const DEMO_USERS: CurrentUser[] = [
  { id: 'user_demo_manager', name: 'Demo Manager', role: 'manager', workspaces: ['food', 'bar'] },
  { id: 'user_demo_chef', name: 'Demo Line Cook (Food staff)', role: 'staff', workspaces: ['food'] },
  { id: 'user_demo_bartender', name: 'Demo Bartender (Bar staff)', role: 'staff', workspaces: ['bar'] },
];

export class DemoRepository implements Repository {
  readonly mode = 'demo' as const;
  private state: AppState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  persistent = true;

  constructor(private storage: StorageLike | null, readonly clock: Clock = systemClock, private timeZone = 'America/New_York') {}

  private seed(anchor?: string): AppState {
    const day = anchor ?? todayIn(this.clock, this.timeZone);
    const s = buildDemoState(day, this.timeZone);
    if (anchor) s.clock.override = anchor;
    return s;
  }

  private persist() {
    if (!this.storage || !this.state) return;
    try {
      this.storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(this.state));
      this.persistent = true;
    } catch {
      this.persistent = false;
    }
  }

  async load(): Promise<AppState> {
    if (this.state) return this.state;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(DEMO_STORAGE_KEY) ?? null;
    } catch {
      this.persistent = false;
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AppState;
        if (parsed.schemaVersion === DEMO_SCHEMA_VERSION && parsed.mode === 'demo') this.state = parsed;
      } catch {
        /* corrupted: reseed */
      }
    }
    if (!this.state) {
      this.state = this.seed();
      this.persist();
    }
    return this.state;
  }

  /** Commands are serialized so each one validates against the latest state (atomic in demo). */
  run<K extends Command>(cmd: K, ...args: CommandArgs<K>): Promise<{ state: AppState; result: CommandResult<K>; replayed?: boolean }> {
    const next = this.queue.then(async () => {
      const s = await this.load();
      const fn = COMMANDS[cmd] as unknown as (state: AppState, ctx: ops.OpCtx, ...a: unknown[]) => ops.OpResult<CommandResult<K>>;
      const out = fn(s, { actor: s.currentUser, clock: this.clock, source: 'ui' }, ...args);
      this.state = out.state;
      this.persist();
      return out;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async reset(anchor?: string): Promise<AppState> {
    await this.queue;
    try {
      this.storage?.removeItem(DEMO_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.state = this.seed(anchor);
    this.persist();
    return this.state;
  }

  async setUser(user: CurrentUser): Promise<AppState> {
    await this.queue;
    const s = structuredClone(await this.load());
    s.currentUser = user;
    this.state = s;
    this.persist();
    return s;
  }

  async setClockOverride(date: string | null): Promise<AppState> {
    await this.queue;
    const s = structuredClone(await this.load());
    s.clock.override = date;
    this.state = s;
    this.persist();
    return s;
  }
}
