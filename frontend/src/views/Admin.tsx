import { useCallback, useEffect, useState } from 'react'
import {
  getArrScheduleBreakdown,
  getEodSnapshots,
  getEodSnapshotContents,
  takeEodSnapshotNow,
  type ArrScheduleBreakdownMatch,
} from '../api'

function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type SnapshotContents = {
  snapshot_date: string
  snapshot_utc: string | null
  counts: { accounts: number; opportunities: number; opportunity_line_items: number }
  carr_summary: { grand_total: number; accounts_with_arr: number }
} | null

/** Format UTC snapshot time as Eastern so "last night" is obvious (23:59 EST = 04:59 UTC next day). */
function formatSnapshotTimeEst(utcIso: string | null): string | null {
  if (!utcIso) return null
  try {
    const d = new Date(utcIso)
    if (Number.isNaN(d.getTime())) return null
    const est = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, month: 'short', day: 'numeric', year: '2-digit' })
    const tz = Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'ET'
    return `${est} ${tz}`
  } catch {
    return null
  }
}

function ArrBreakdownCard({ m }: { m: ArrScheduleBreakdownMatch }) {
  const a = m.active_arr_explanation
  const c = m.contracted_arr_explanation
  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '1rem',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: '0.9rem',
        color: 'var(--text)',
      }}
    >
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1.05rem' }}>{m.account_name}</h3>
      <p style={{ margin: '0 0 0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        As of <strong>{m.as_of_date_est}</strong> ({m.timezone}) · Alleva adjustment flag:{' '}
        <strong>{m.apply_alleva_retained_arr_adjustment ? 'on' : 'off'}</strong> (matches Products purchased)
      </p>
      <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        <li>
          Account ID: <code style={{ fontSize: '0.8rem' }}>{m.account_id ?? '—'}</code> · Type: {m.account_type ?? '—'} · Status:{' '}
          {m.status ?? '—'} {m.is_churned ? <strong style={{ color: 'var(--negative)' }}>(churned → ARR forced to 0)</strong> : null}
        </li>
        <li>Open renewal override list: {m.in_open_renewal_override_list ? 'yes' : 'no'}</li>
        <li>Open renewal line ARR (sum of open Renewal opps): {fmtUsd(m.open_renewal_line_arr)}</li>
        <li>Anchor opp ARR: {fmtUsd(m.anchor_opportunity_arr)} · Expansions ≤ today: {fmtUsd(m.expansion_arr_sum_close_on_or_before_today)}</li>
        <li>
          Subscription window (legacy display): {m.subscription_window.start ?? '—'} → {m.subscription_window.end ?? '—'}
        </li>
        {m.schedule_note ? (
          <li>
            Schedule note: <em>{m.schedule_note}</em>
          </li>
        ) : null}
      </ul>

      <h4 style={{ margin: '0.5rem 0 0.35rem', fontSize: '0.95rem' }}>Closed-won periods (NB + renewals) → schedule ARR</h4>
      {m.closed_won_periods_with_arr.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--text-muted)' }}>No closed-won periods in schedule.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', marginBottom: '0.75rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '0.25rem 0.5rem 0.25rem 0' }}>Start</th>
              <th style={{ padding: '0.25rem 0.5rem' }}>End</th>
              <th style={{ padding: '0.25rem 0' }}>ARR</th>
            </tr>
          </thead>
          <tbody>
            {m.closed_won_periods_with_arr.map((p, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.2rem 0.5rem 0.2rem 0' }}>{p.start}</td>
                <td style={{ padding: '0.2rem 0.5rem' }}>{p.end}</td>
                <td style={{ padding: '0.2rem 0' }}>{fmtUsd(p.arr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>
        Period containing today:{' '}
        {m.period_containing_today ? (
          <>
            {m.period_containing_today.start} → {m.period_containing_today.end} · {fmtUsd(m.period_containing_today.arr)}
          </>
        ) : (
          <em>none</em>
        )}
      </p>

      <h4 style={{ margin: '0.5rem 0 0.35rem', fontSize: '0.95rem', color: 'var(--accent)' }}>Active ARR (calculation)</h4>
      <ol style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', fontSize: '0.85rem', lineHeight: 1.5 }}>
        <li>
          <strong>Schedule rule:</strong> {String(a.schedule_branch ?? '')}
        </li>
        <li>
          Value after schedule only: <strong>{fmtUsd(Number(a.value_after_schedule_only))}</strong>
        </li>
        <li>
          Open renewal override applied: {a.open_renewal_override_applied ? 'yes → Active set to open renewal line ARR' : 'no'}
        </li>
        <li>
          After override, before churn rule: <strong>{fmtUsd(Number(a.value_after_override_before_churn))}</strong>
        </li>
        <li>
          After churn rule, before Alleva: <strong>{fmtUsd(Number(a.value_after_churn_before_alleva))}</strong>
        </li>
        <li>
          Alleva retained factor: {a.alleva_retained_factor_applied != null ? String(a.alleva_retained_factor_applied) : 'none'}
        </li>
        <li>
          <strong>Final Active ARR:</strong> {fmtUsd(Number(a.final_active_arr))}
        </li>
      </ol>

      <h4 style={{ margin: '0.5rem 0 0.35rem', fontSize: '0.95rem', color: 'var(--accent)' }}>Contracted ARR (calculation)</h4>
      <ol style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', fontSize: '0.85rem', lineHeight: 1.5 }}>
        <li>
          <strong>Rule:</strong> {String(c.branch ?? '')}
        </li>
        {c.future_period_used && typeof c.future_period_used === 'object' ? (
          <li>
            Soonest future period: {(c.future_period_used as { start?: string }).start} →{' '}
            {(c.future_period_used as { end?: string }).end} · ARR{' '}
            {fmtUsd(Number((c.future_period_used as { arr?: number }).arr))}
          </li>
        ) : null}
        <li>
          Before churn: <strong>{fmtUsd(Number(c.value_before_churn))}</strong> · After churn, before Alleva:{' '}
          <strong>{fmtUsd(Number(c.value_after_churn_before_alleva))}</strong>
        </li>
        <li>
          Alleva retained factor: {c.alleva_retained_factor_applied != null ? String(c.alleva_retained_factor_applied) : 'none'}
        </li>
        <li>
          <strong>Final Contracted ARR:</strong> {fmtUsd(Number(c.final_contracted_arr))}
        </li>
      </ol>

      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{m.products_purchased_note}</p>

      <details style={{ marginTop: '0.75rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Raw JSON</summary>
        <pre
          style={{
            margin: '0.5rem 0 0',
            padding: '0.5rem',
            background: 'var(--bg)',
            borderRadius: 4,
            overflow: 'auto',
            fontSize: '0.72rem',
          }}
        >
          {JSON.stringify(m, null, 2)}
        </pre>
      </details>
    </div>
  )
}

export default function Admin() {
  const [breakdownQuery, setBreakdownQuery] = useState('12 south')
  const [breakdownLoading, setBreakdownLoading] = useState(false)
  const [breakdownErr, setBreakdownErr] = useState<string | null>(null)
  const [breakdownMatches, setBreakdownMatches] = useState<ArrScheduleBreakdownMatch[] | null>(null)

  const [snapshots, setSnapshots] = useState<Array<{ snapshot_date: string; snapshot_utc: string | null }> | null>(null)
  const [snapshotsErr, setSnapshotsErr] = useState<string | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null)
  const [viewingDate, setViewingDate] = useState<string | null>(null)
  const [contents, setContents] = useState<SnapshotContents>(null)
  const [contentsErr, setContentsErr] = useState<string | null>(null)

  const loadSnapshots = useCallback(() => {
    getEodSnapshots()
      .then((res) => setSnapshots(res.snapshots || []))
      .catch((e) => setSnapshotsErr(e.message))
  }, [])

  useEffect(() => {
    loadSnapshots()
  }, [loadSnapshots])

  const handleViewContents = (date: string) => {
    setViewingDate(date)
    setContents(null)
    setContentsErr(null)
    getEodSnapshotContents(date)
      .then((data) => setContents(data))
      .catch((e) => setContentsErr(e.message))
  }

  const loadArrBreakdown = () => {
    setBreakdownLoading(true)
    setBreakdownErr(null)
    setBreakdownMatches(null)
    getArrScheduleBreakdown(breakdownQuery.trim() || '12 south')
      .then((res) => setBreakdownMatches(res.matches ?? []))
      .catch((e) => setBreakdownErr(e.message ?? 'Failed'))
      .finally(() => setBreakdownLoading(false))
  }

  const handleTakeSnapshot = () => {
    setSnapshotStatus('loading')
    setSnapshotMessage(null)
    takeEodSnapshotNow()
      .then((res) => {
        if (res.ok) {
          setSnapshotStatus('ok')
          setSnapshotMessage(res.message ?? 'Snapshot saved.')
          loadSnapshots()
        } else {
          setSnapshotStatus('error')
          setSnapshotMessage(res.error ?? 'Failed')
        }
      })
      .catch((e) => {
        setSnapshotStatus('error')
        setSnapshotMessage(e.message ?? 'Failed to take snapshot')
      })
  }

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Admin</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        EOD snapshots are taken automatically at 23:59 EST. Use the button below to capture one now (e.g. after a sync).
      </p>

      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
        ARR schedule breakdown (Active vs Contracted)
      </h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem', maxWidth: 720 }}>
        Step-by-step calculation used for <strong>Products purchased</strong> schedule columns (same as export). Enter a substring of
        the Salesforce account name (default <code>12 south</code> for 12 South Recovery).
      </p>
      <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <label htmlFor="arr-breakdown-q" style={{ fontSize: '0.9rem', color: 'var(--text)' }}>
          Account name contains
        </label>
        <input
          id="arr-breakdown-q"
          type="text"
          value={breakdownQuery}
          onChange={(e) => setBreakdownQuery(e.target.value)}
          placeholder="12 south"
          style={{
            padding: '0.4rem 0.6rem',
            minWidth: 200,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: '0.9rem',
          }}
        />
        <button
          type="button"
          onClick={loadArrBreakdown}
          disabled={breakdownLoading}
          style={{
            padding: '0.45rem 0.9rem',
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: breakdownLoading ? 'wait' : 'pointer',
            background: 'var(--surface)',
            color: 'var(--accent)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          {breakdownLoading ? 'Loading…' : 'Show breakdown'}
        </button>
      </div>
      {breakdownErr && <p style={{ color: 'var(--negative)', fontSize: '0.9rem', marginBottom: '1rem' }}>{breakdownErr}</p>}
      {breakdownMatches && breakdownMatches.length === 0 && !breakdownErr && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          No accounts matched that substring.
        </p>
      )}
      {breakdownMatches && breakdownMatches.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          {breakdownMatches.map((m, i) => (
            <ArrBreakdownCard key={`${m.account_id ?? m.account_name}-${i}`} m={m} />
          ))}
        </div>
      )}

      <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleTakeSnapshot}
          disabled={snapshotStatus === 'loading'}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: snapshotStatus === 'loading' ? 'wait' : 'pointer',
            background: 'var(--accent)',
            color: 'white',
            border: 'none',
            borderRadius: 6,
          }}
        >
          {snapshotStatus === 'loading' ? 'Taking snapshot…' : 'Take snapshot now'}
        </button>
        {snapshotStatus === 'ok' && snapshotMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--positive)' }}>{snapshotMessage}</span>
        )}
        {snapshotStatus === 'error' && snapshotMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--negative)' }}>{snapshotMessage}</span>
        )}
      </div>

      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Recent snapshots</h2>
      {snapshotsErr && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{snapshotsErr}</p>}
      {snapshots && snapshots.length === 0 && !snapshotsErr && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No snapshots yet. Run the app at 23:59 EST or take one above.</p>
      )}
      {snapshots && snapshots.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.9rem', color: 'var(--text)' }}>
          {snapshots.slice(0, 10).map((s, i) => (
            <li key={i} style={{ marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <strong>{s.snapshot_date}</strong>
              {s.snapshot_utc && (
                <span style={{ color: 'var(--text-muted)' }} title={s.snapshot_utc + ' UTC'}>
                  (taken {formatSnapshotTimeEst(s.snapshot_utc) ?? s.snapshot_utc})
                </span>
              )}
              <button
                type="button"
                onClick={() => handleViewContents(s.snapshot_date)}
                style={{
                  padding: '0.2rem 0.5rem',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  background: 'var(--surface)',
                  color: 'var(--accent)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                }}
              >
                View contents
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewingDate && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Snapshot {viewingDate}
          </div>
          {contentsErr && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{contentsErr}</p>}
          {contents && (
            <div style={{ fontSize: '0.9rem', color: 'var(--text)' }}>
              <p style={{ margin: '0.25rem 0' }}>
                <strong>Counts:</strong> {contents.counts.accounts} accounts, {contents.counts.opportunities} opportunities, {contents.counts.opportunity_line_items} line items.
              </p>
              <p style={{ margin: '0.25rem 0' }}>
                <strong>CARR:</strong> ${(contents.carr_summary.grand_total ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} total across {contents.carr_summary.accounts_with_arr} account(s).
              </p>
            </div>
          )}
        </div>
      )}
    </>
  )
}
