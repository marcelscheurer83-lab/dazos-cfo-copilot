import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import {
  generateArrBridgeSlide,
  getSlidesArrBridgeMonth,
  type GenerateArrBridgeSlideResult,
  type SlidesArrBridgeMonth,
} from '../api'

// Deck color code (page 57 "ARR bridge and contracted ARR")
const COLORS = {
  total: '#1f9bd6', // BoP / EoP actual / EoP CARR — blue
  up: '#7ac043', // New business / Expansion / Future start — green
  down: '#f5c542', // Churn / Contraction — yellow
  delta: '#e0584b', // Delta vs plan — red
  plan: '#c7ccd1', // EoP ARR plan — grey
  title: '#1f9bd6',
}

type WBar = { name: string; base: number; value: number; fill: string; label: number; total: boolean }

/** Previous calendar month key, e.g. on Jun 9 → "2026-05". */
function defaultMonthKey(): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), 0) // last day of previous month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Last 12 month keys (most recent first) for the selector. */
function recentMonthKeys(): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const now = new Date()
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    out.push({ key, label: label.replace(' ', " '") })
  }
  return out
}

function fmtK(v: number): string {
  return `$${Math.round(v).toLocaleString()}K`
}

function buildWaterfall(d: SlidesArrBridgeMonth): { bars: WBar[]; yMin: number; yMax: number } {
  const K = 1000
  const bop = d.beginning_arr / K
  const nb = d.new_business / K
  const exp = d.expansion / K
  const churn = d.churn / K
  const ctr = d.contraction / K
  const eop = d.ending_arr_actual / K
  const fs = d.future_start_arr / K
  const carr = d.ending_carr_actual / K
  const hasPlan = d.ending_arr_plan != null
  const plan = (d.ending_arr_plan ?? 0) / K
  const delta = (d.delta_plan_vs_carr ?? 0) / K

  const r1 = bop + nb
  const r2 = r1 + exp
  const r3 = r2 - churn
  const r4 = r3 - ctr // ≈ eop

  const bars: WBar[] = [
    { name: 'BoP ARR', base: 0, value: bop, fill: COLORS.total, label: bop, total: true },
    { name: 'New business', base: bop, value: nb, fill: COLORS.up, label: nb, total: false },
    { name: 'Expansion', base: r1, value: exp, fill: COLORS.up, label: exp, total: false },
    { name: 'Churn', base: r3, value: churn, fill: COLORS.down, label: churn, total: false },
    { name: 'Contraction', base: r4, value: ctr, fill: COLORS.down, label: ctr, total: false },
    { name: 'EoP ARR actual', base: 0, value: eop, fill: COLORS.total, label: eop, total: true },
    { name: 'Future start date', base: eop, value: fs, fill: COLORS.up, label: fs, total: false },
    { name: 'EoP CARR actual', base: 0, value: carr, fill: COLORS.total, label: carr, total: true },
  ]
  if (hasPlan) {
    bars.push(
      delta >= 0
        ? { name: 'Delta', base: carr, value: delta, fill: COLORS.delta, label: delta, total: false }
        : { name: 'Delta', base: plan, value: -delta, fill: COLORS.delta, label: -delta, total: false },
    )
    bars.push({ name: 'EoP ARR plan', base: 0, value: plan, fill: COLORS.plan, label: plan, total: true })
  }

  const tops = bars.map((b) => b.base + b.value)
  const maxTop = Math.max(...tops, 1)
  const minTotal = Math.min(...bars.filter((b) => b.total).map((b) => b.value))
  const yMin = Math.max(0, Math.floor((minTotal - 1200) / 500) * 500)
  const yMax = Math.ceil((maxTop + 300) / 500) * 500
  return { bars, yMin, yMax }
}

export default function BoardSlides() {
  const monthOptions = useMemo(() => recentMonthKeys(), [])
  const [month, setMonth] = useState<string>(defaultMonthKey())
  const [data, setData] = useState<SlidesArrBridgeMonth | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genResult, setGenResult] = useState<GenerateArrBridgeSlideResult | null>(null)
  const [genError, setGenError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setErr(null)
    setGenResult(null)
    setGenError(null)
    getSlidesArrBridgeMonth(month)
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [month])

  const handleGenerate = () => {
    setGenerating(true)
    setGenResult(null)
    setGenError(null)
    generateArrBridgeSlide(month)
      .then((res) => {
        if (res.ok) setGenResult(res)
        else setGenError(res.error ?? 'Slide generation failed.')
      })
      .catch((e) => setGenError(e instanceof Error ? e.message : String(e)))
      .finally(() => setGenerating(false))
  }

  const wf = useMemo(() => (data ? buildWaterfall(data) : null), [data])

  return (
    <div style={{ color: 'var(--text)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: '0.25rem' }}>Board Slides</h2>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Generate board-deck slides for the previous month and push them into your Google Slides deck.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Month</label>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{
              padding: '0.4rem 0.6rem',
              fontSize: '0.85rem',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--bg)',
              color: 'var(--text)',
            }}
          >
            {monthOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {err && <p style={{ color: 'var(--negative)' }}>{err}</p>}
      {!err && loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
      {!err && !loading && data?.message && <p style={{ color: 'var(--text-muted)' }}>{data.message}</p>}

      {!err && !loading && data && wf && (
        <>
          {/* Slide preview — rendered on a white card to mirror the deck */}
          <div
            style={{
              marginTop: '1rem',
              background: '#ffffff',
              borderRadius: 8,
              border: '1px solid var(--border)',
              padding: '1.5rem 1.75rem',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              aspectRatio: '16 / 9',
              maxWidth: 1040,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, color: COLORS.title, fontSize: '1.5rem', fontWeight: 700 }}>
                {data.month_label} ARR bridge and contracted ARR
              </h3>
              <span style={{ color: COLORS.title, fontStyle: 'italic', fontWeight: 700, fontSize: '0.9rem', letterSpacing: 1 }}>
                APPENDIX
              </span>
            </div>
            <div style={{ flex: 1, width: '100%', minHeight: 0, marginTop: '0.5rem' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={wf.bars} margin={{ top: 24, right: 16, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="#e6e8eb" vertical={false} />
                  <XAxis
                    dataKey="name"
                    interval={0}
                    tick={{ fill: '#555', fontSize: 11 }}
                    axisLine={{ stroke: '#cfd3d7' }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[wf.yMin, wf.yMax]}
                    allowDataOverflow
                    tick={{ fill: '#888', fontSize: 11 }}
                    tickFormatter={(v) => fmtK(Number(v))}
                    axisLine={false}
                    tickLine={false}
                    width={64}
                  />
                  <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                  <Bar dataKey="value" stackId="w" isAnimationActive={false}>
                    {wf.bars.map((b, i) => (
                      <Cell key={i} fill={b.fill} />
                    ))}
                    <LabelList
                      dataKey="label"
                      position="top"
                      formatter={(v: unknown) => Math.round(Number(v)).toLocaleString()}
                      style={{ fill: '#333', fontSize: 11, fontWeight: 600 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ fontSize: '0.7rem', color: '#999', marginTop: '0.25rem' }}>Source: SFDC and Alleva reporting</div>
          </div>

          {/* Actions */}
          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              style={{
                padding: '0.55rem 1rem',
                fontSize: '0.85rem',
                fontWeight: 600,
                borderRadius: 6,
                border: '1px solid var(--accent)',
                background: generating ? 'var(--surface)' : 'var(--accent)',
                color: generating ? 'var(--text-muted)' : '#fff',
                cursor: generating ? 'wait' : 'pointer',
              }}
            >
              {generating ? 'Generating…' : 'Generate in Google Slides'}
            </button>
            {genResult?.ok && genResult.deck_url && (
              <a href={genResult.deck_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.85rem', color: 'var(--accent)' }}>
                {genResult.replaced ? 'Updated slide' : 'Added slide'} — open in Google Slides ↗
              </a>
            )}
          </div>
          {genError && (
            <p style={{ marginTop: '0.5rem', color: 'var(--negative)', fontSize: '0.8rem', maxWidth: 760 }}>{genError}</p>
          )}
          {genResult?.ok && genResult.thumbnail_url && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Generated slide in the deck:</div>
              <img
                src={genResult.thumbnail_url}
                alt="Generated ARR bridge slide"
                style={{ maxWidth: 1040, width: '100%', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </div>
          )}

          {/* Value table for sanity-checking the preview */}
          <div style={{ marginTop: '1.25rem', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', maxWidth: 520 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <tbody>
                {[
                  ['BoP ARR', data.beginning_arr],
                  ['New business', data.new_business],
                  ['Expansion', data.expansion],
                  ['Churn', -data.churn],
                  ['Contraction', -data.contraction],
                  ['EoP ARR actual', data.ending_arr_actual],
                  ['Future start date', data.future_start_arr],
                  ['EoP CARR actual', data.ending_carr_actual],
                  ['Delta (plan − CARR)', data.delta_plan_vs_carr ?? 0],
                  ['EoP ARR plan', data.ending_arr_plan ?? 0],
                ].map(([label, val], i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.45rem 0.75rem', color: 'var(--text-muted)' }}>{label as string}</td>
                    <td style={{ padding: '0.45rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>
                      {fmtK((val as number) / 1000)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
