import { useState } from 'react';
import { isValidTimeZone } from '../domain/dates';
import { isManager } from '../domain/ops';
import type { DatePolicy } from '../domain/types';
import { aiAvailability } from '../data/ai';
import { DEMO_USERS } from '../data/demo';
import { Button, Field, Notice, Section, Toggle } from './components';
import { Team } from './Team';
import { useApp } from './store';

export function Settings() {
  const { state, run, demo, replaceState, repo, toast, catalog } = useApp();
  const mgr = isManager(state.currentUser);
  const [tz, setTz] = useState(state.org.timezone);
  const [policy, setPolicy] = useState<DatePolicy>(state.org.policy);
  const [targetPct, setTargetPct] = useState(state.org.targetCostPct ? String(Math.round(state.org.targetCostPct * 100)) : '');
  const [clock, setClock] = useState(state.clock.override ?? '');
  const ai = aiAvailability(repo);
  const staples = [...catalog.ingredients.values()].filter((i) => i.pantryStaple);

  return (
    <div className="space-y-8">
      {state.mode === 'demo' && demo && (
        <Section title="Demo mode" description="Demo data lives only in this browser (localStorage). It is isolated from any live organization and does not sync across devices or users.">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Act as (demo role)">{(id) => (
              <select id={id} className="input" value={state.currentUser.id} onChange={async (e) => { const u = DEMO_USERS.find((x) => x.id === e.target.value); if (u) replaceState(await demo.setUser(u)); }}>
                {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            )}</Field>
            <Field label="Demo clock (today)" hint="Freeze the demo date for testing. Empty = real date.">{(id) => (
              <div className="flex gap-2">
                <input id={id} type="date" className="input" value={clock} onChange={(e) => setClock(e.target.value)} />
                <Button onClick={async () => replaceState(await demo.setClockOverride(clock || null))}>Set</Button>
              </div>
            )}</Field>
            <div className="flex items-end">
              <Button variant="danger" onClick={async () => { if (window.confirm('Reset all demo data in this browser?')) { replaceState(await demo.reset(clock || undefined)); toast('ok', 'Demo data reset.'); } }}>Reset demo data</Button>
            </div>
          </div>
          {!demo.persistent && <Notice tone="warn">Browser storage is unavailable (private window or blocked). Demo changes will be lost on refresh.</Notice>}
        </Section>
      )}

      <Team />

      <Section title="Organization & date policy" description="Eligibility is evaluated for the planned service date in this timezone. Configure policies to match your jurisdiction and verified procedures.">
        {!mgr && <Notice>Only managers can change these settings.</Notice>}
        <Notice>{state.org.policy.jurisdictionNote} This tool does not determine regulatory compliance; see the FDA Food Code and USDA date-labeling guidance referenced in the documentation.</Notice>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Timezone (IANA)" hint={isValidTimeZone(tz) ? undefined : 'Not a valid timezone'}>{(id) => <input id={id} className="input" value={tz} onChange={(e) => setTz(e.target.value)} disabled={!mgr} />}</Field>
          <Field label="Upcoming-date alert (days)">{(id) => <input id={id} type="number" min={0} max={30} className="input" value={policy.alertDays} onChange={(e) => setPolicy({ ...policy, alertDays: Number(e.target.value) })} disabled={!mgr} />}</Field>
          <Field label="Target ingredient cost %">{(id) => <input id={id} type="number" min={1} max={99} className="input" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} disabled={!mgr} />}</Field>
          <Toggle checked={policy.cutoffInclusive} onChange={(v) => mgr && setPolicy({ ...policy, cutoffInclusive: v })} label="Usable on the cutoff date itself" description="Off = unusable starting on the cutoff date" />
          <Toggle checked={policy.useByIsHard} onChange={(v) => mgr && setPolicy({ ...policy, useByIsHard: v })} label="Use-by is a hard cutoff" description="Off = passing it requires manager review" />
          <Toggle checked={policy.expirationIsHard} onChange={(v) => mgr && setPolicy({ ...policy, expirationIsHard: v })} label="Expiration is a hard cutoff" />
          <Toggle checked={policy.sellByPassed === 'review'} onChange={(v) => mgr && setPolicy({ ...policy, sellByPassed: v ? 'review' : 'info' })} label="Passed sell-by requires review" description="Off = informational only" />
          <Toggle checked={policy.requireCutoffForPerishable} onChange={(v) => mgr && setPolicy({ ...policy, requireCutoffForPerishable: v })} label="Perishables need a cutoff date" description="Lots without one are held for review; dates are never invented" />
          <Toggle checked={policy.requireVerifiedDatesForPerishable} onChange={(v) => mgr && setPolicy({ ...policy, requireVerifiedDatesForPerishable: v })} label="Perishable dates must be verified" />
        </div>
        <p className="text-xs text-ink-mute">Passed quality (best-by) dates always require a recorded manager review and can never extend past a hard cutoff.</p>
        {mgr && <Button variant="primary" disabled={!isValidTimeZone(tz)} onClick={() => run('updateOrgSettings', { timezone: tz, policy, targetCostPct: targetPct ? Number(targetPct) / 100 : null })}>Save settings</Button>}
      </Section>

      <Section title="Pantry staples" description="Untracked staples count as available only when a manager confirms them. Recipes using assumed staples disclose it and never claim exact capacity.">
        <div className="card divide-y divide-paper-line">
          {staples.map((i) => {
            const c = state.org.confirmedStaples.find((s) => s.ingredientId === i.id);
            return (
              <div key={i.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="font-medium">{i.name}</span>
                {c ? <span className="text-ink-mute">Confirmed by {c.confirmedBy}{c.assumeZeroCost ? ' · cost treated as zero' : ''}</span> : <span className="text-ink-mute">Not assumed — must be in inventory</span>}
                {mgr && <Button size="sm" className="ml-auto" aria-label={`${c ? 'Stop assuming' : 'Assume'} ${i.name} on hand`} onClick={() => run('setStaple', i.id, !c, true)}>{c ? 'Stop assuming' : 'Assume on hand'}</Button>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="AI assistance">
        {ai.available ? <Notice tone="ok">AI suggestions are enabled. They are validated and recomputed by the engine, labeled as AI drafts, and require review.</Notice> : <Notice>{ai.reason}</Notice>}
      </Section>

      <Section title="About this data">
        <ul className="ml-4 list-disc text-sm text-ink-soft">
          <li>Mode: {state.mode === 'demo' ? 'Demo (browser-local)' : 'Live (Supabase)'} · Org: {state.org.name}</li>
          <li>{state.lots.length} lots · {state.movements.length} ledger movements · {state.audit.length} audit events · {state.recipes.length} recipes</li>
          <li>Rounding: quantities to 0.000001 of a base unit; displayed quantities rounded; shortfalls rounded up.</li>
        </ul>
        {mgr && state.audit.length > 0 && (
          <details className="card p-3 text-xs">
            <summary className="cursor-pointer font-semibold">Recent audit events</summary>
            <ul className="mt-2 space-y-1">{[...state.audit].reverse().slice(0, 40).map((a) => <li key={a.id}>{a.at.slice(0, 19).replace('T', ' ')} · {a.action} · {a.entity} {a.entityId.slice(-8)} {a.reason ? `· ${a.reason}` : ''} · {a.source}</li>)}</ul>
          </details>
        )}
      </Section>
    </div>
  );
}
