import { useState } from 'react'
import { getArrScheduleBreakdown, type ArrScheduleBreakdownMatch } from '../api'

function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

  const loadArrBreakdown = () => {
    setBreakdownLoading(true)
    setBreakdownErr(null)
    setBreakdownMatches(null)
    getArrScheduleBreakdown(breakdownQuery.trim() || '12 south')
      .then((res) => setBreakdownMatches(res.matches ?? []))
      .catch((e) => setBreakdownErr(e.message ?? 'Failed'))
      .finally(() => setBreakdownLoading(false))
  }

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Admin</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1.5rem', maxWidth: 720 }}>
        Load CRM and related data from the <strong>Dashboard</strong> using <strong>Refresh app data</strong>. The backend saves a daily <strong>end-of-day snapshot</strong> at 23:59 Eastern from whatever is already in the database—refresh before then if you rely on manual sync only (hourly Salesforce sync is optional via server config).
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
    </>
  )
}
