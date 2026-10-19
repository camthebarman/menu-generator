import { useMemo, useState } from 'react';
import { downloadText, toCsv } from '../domain/csv';
import { computeShopping } from '../domain/shopping';
import { formatMoney } from '../domain/units';
import { Button, Empty, Field, GroupBadge, Notice, Section, Toggle } from './components';
import { requestedLabel } from './MatchDetail';
import { useApp, useHashRoute } from './store';

export function Shopping() {
  const { state, workspace, cart, setCart, today, run, toast, catalog } = useApp();
  const [, nav] = useHashRoute();
  const [date, setDate] = useState(today);
  const [protectMenu, setProtectMenu] = useState(true);
  const selections = cart[workspace];
  const result = useMemo(() => computeShopping(state, workspace, date, selections, protectMenu), [state, workspace, date, selections, protectMenu]);
  const total = result.rows.every((r) => r.estCost !== null) && result.rows.length ? result.rows.reduce((s, r) => s + (r.estCost ?? 0), 0) : null;

  const exportCsv = () => {
    const csv = toCsv(['ingredient', 'quantity_to_buy', 'status', 'needed_by', 'estimated_cost'], result.rows.map((r) => [r.name, r.display, r.missingCompletely ? 'missing' : 'insufficient', r.neededBy.join('; '), r.estCost !== null ? r.estCost.toFixed(2) : '']));
    downloadText(`shopping-${workspace}-${date}.csv`, csv);
  };

  return (
    <Section title="Shopping list" description="Selected one- and two-away recipes are recomputed together against shared stock, so overlapping needs are not double-counted as available."
      actions={<>
        <Button onClick={exportCsv} disabled={!result.rows.length}>Export CSV</Button>
        <Button onClick={() => window.print()} disabled={!result.rows.length}>Print</Button>
      </>}>
      {selections.length === 0 ? (
        <Empty title="Nothing selected">Open a "Need 1" or "Need 2" result in Discover and choose "Add to shopping list". <Button size="sm" variant="ghost" onClick={() => nav('discover')}>Go to Discover</Button></Empty>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="For service on">{(id) => <input id={id} type="date" min={today} className="input" value={date} onChange={(e) => setDate(e.target.value || today)} />}</Field>
            <Toggle checked={protectMenu} onChange={setProtectMenu} label="Protect current menu stock" />
          </div>
          <div className="card p-3">
            <h3 className="text-base font-semibold">Selected recipes</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {selections.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{catalog.recipes.get(s.recipeId)?.name}</span>
                  <span className="text-ink-mute">{requestedLabel(s.requested)}</span>
                  <Button size="sm" variant="ghost" onClick={() => setCart(workspace, selections.filter((_, k) => k !== i))}>Remove</Button>
                </li>
              ))}
            </ul>
            {result.combined && <div className="mt-2 flex items-center gap-2 text-sm">Together after buying: {result.combined.issues.length ? <GroupBadge group="needs_review" /> : <span className="chip border-ok/30 bg-ok-soft text-ok">all covered</span>}</div>}
          </div>
          {result.notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
          <div className="card overflow-x-auto p-2">
            <table className="table-base">
              <thead><tr><th>Buy</th><th className="text-right">Quantity</th><th>Why</th><th className="text-right">Est. cost</th></tr></thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.ingredientId}>
                    <td className="font-medium">{r.name}</td>
                    <td className="text-right font-semibold tabular-nums">{r.display}</td>
                    <td className="text-xs">{r.missingCompletely ? 'Not in free stock' : 'Not enough free stock'} · for {r.neededBy.join(', ')}</td>
                    <td className="text-right tabular-nums">{r.estCost !== null ? formatMoney(r.estCost, state.org.currency) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.rows.length === 0 && <Empty title="Nothing to buy">Selected recipes are covered by free stock for this date.</Empty>}
            <p className="px-2 pt-2 text-xs text-ink-mute">Quantities are exact shortfalls rounded up; buy in your supplier's pack sizes. Estimates use reference costs where recorded{total !== null ? ` (total ≈ ${formatMoney(total, state.org.currency)})` : ''}.</p>
          </div>
          <div className="no-print flex gap-2">
            <Button variant="primary" onClick={async () => { const r = await run('saveShoppingList', { workspace, serviceDate: date, selections }); if (r) toast('ok', 'Shopping list saved.'); }}>Save list</Button>
            <Button variant="ghost" onClick={() => setCart(workspace, [])}>Clear</Button>
          </div>
          {state.shoppingLists.filter((l) => l.workspace === workspace).length > 0 && (
            <p className="text-xs text-ink-mute">Saved lists: {state.shoppingLists.filter((l) => l.workspace === workspace).map((l) => `${l.serviceDate} (${l.selections.length})`).join(', ')}</p>
          )}
        </div>
      )}
    </Section>
  );
}
