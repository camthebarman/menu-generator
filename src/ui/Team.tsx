import { useCallback, useEffect, useState } from 'react';
import type { InviteRow, MemberRow } from '../data/live';
import { SupabaseRepository } from '../data/live';
import { isManager } from '../domain/ops';
import type { Workspace } from '../domain/types';
import { Button, Field, Notice, Section } from './components';
import { useApp } from './store';

export function Team() {
  const { repo, state, toast } = useApp();
  const live = repo instanceof SupabaseRepository ? repo : null;
  const mgr = isManager(state.currentUser);
  const owner = state.currentUser.role === 'owner';
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [role, setRole] = useState<'staff' | 'manager'>('staff');
  const [ws, setWs] = useState<Workspace[]>(['food']);
  const [note, setNote] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!live || !mgr) return;
    try {
      const [m, i] = await Promise.all([live.listMembers(), live.listInvites()]);
      setMembers(m);
      setInvites(i);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [live, mgr]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!live) return <Section title="Team"><Notice>Team management is available in live mode. In the demo, switch roles under Demo mode above.</Notice></Section>;
  if (!mgr) return <Section title="Team"><Notice>You are signed in as {state.currentUser.role} for {state.currentUser.workspaces.join(' + ')}. Ask a manager to change access.</Notice></Section>;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null);
    try {
      await fn();
      toast('ok', ok);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Section title="Team" description="Staff see Shared stock plus their workspaces. Managers see every pool. Changes apply on the member's next refresh.">
      {err && <Notice tone="block">{err}</Notice>}
      <div className="card divide-y divide-paper-line">
        {members.map((m) => (
          <div key={m.userId} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="min-w-[10rem] font-medium">{m.displayName ?? m.userId.slice(0, 8)}{m.userId === state.currentUser.id ? ' (you)' : ''}</span>
            <select aria-label={`Role for ${m.displayName}`} className="input w-32" value={m.role} disabled={!owner && m.role !== 'staff'}
              onChange={(e) => act(() => live.updateMember(m.userId, e.target.value as MemberRow['role'], m.workspaces), 'Role updated')}>
              <option value="staff">staff</option>
              {(owner || m.role === 'manager') && <option value="manager">manager</option>}
              {(owner || m.role === 'owner') && <option value="owner">owner</option>}
            </select>
            {(['food', 'bar'] as Workspace[]).map((w) => (
              <label key={w} className="flex items-center gap-1">
                <input type="checkbox" checked={m.workspaces.includes(w)} disabled={!owner && m.role !== 'staff'}
                  onChange={(e) => {
                    const next = e.target.checked ? [...m.workspaces, w] : m.workspaces.filter((x) => x !== w);
                    if (next.length) act(() => live.updateMember(m.userId, m.role, next), 'Workspaces updated');
                  }} />{w}
              </label>
            ))}
            {m.userId !== state.currentUser.id && (owner || m.role === 'staff') && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => window.confirm(`Remove ${m.displayName ?? 'this member'}?`) && act(() => live.updateMember(m.userId, m.role, m.workspaces, true), 'Member removed')}>Remove</Button>
            )}
          </div>
        ))}
      </div>
      <div className="card space-y-3 p-3">
        <h3 className="text-base font-semibold">Invite someone</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Role">{(id) => (
            <select id={id} className="input" value={role} onChange={(e) => setRole(e.target.value as 'staff' | 'manager')}>
              <option value="staff">Staff</option>
              {owner && <option value="manager">Manager</option>}
            </select>
          )}</Field>
          <div>
            <div className="label">Workspaces</div>
            <div className="flex gap-3 pt-2 text-sm">
              {(['food', 'bar'] as Workspace[]).map((w) => <label key={w} className="flex items-center gap-1"><input type="checkbox" checked={ws.includes(w)} onChange={(e) => setWs(e.target.checked ? [...ws, w] : ws.filter((x) => x !== w))} />{w}</label>)}
            </div>
          </div>
          <Field label="Note (who it's for)">{(id) => <input id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={ws.length === 0} onClick={() => act(async () => setCode(await live.createInvite(role, ws, note)), 'Invite created')}>Create invite code</Button>
          </div>
        </div>
        {code && (
          <Notice tone="ok" title="Share this code now — it is shown only once">
            <code className="text-lg font-semibold tracking-widest">{code}</code>
            <p className="mt-1 text-xs">They create an account, then choose "Join with an invite code". Expires in 7 days; single use.</p>
          </Notice>
        )}
        {invites.length > 0 && (
          <ul className="space-y-1 text-xs">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span>{i.role} · {i.workspaces.join(' + ')}{i.note ? ` · ${i.note}` : ''} · {i.usedAt ? 'used' : i.revoked ? 'revoked' : new Date(i.expiresAt) < new Date() ? 'expired' : `expires ${i.expiresAt.slice(0, 10)}`}</span>
                {!i.usedAt && !i.revoked && <Button size="sm" variant="ghost" onClick={() => act(() => live.revokeInvite(i.id), 'Invite revoked')}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
