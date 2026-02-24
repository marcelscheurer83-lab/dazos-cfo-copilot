import { useCallback, useEffect, useState } from 'react'
import { getEodSnapshots, getEodSnapshotContents, takeEodSnapshotNow } from '../api'

type SnapshotContents = {
  snapshot_date: string
  snapshot_utc: string | null
  counts: { accounts: number; opportunities: number; opportunity_line_items: number }
  carr_summary: { grand_total: number; accounts_with_arr: number }
} | null

export default function Admin() {
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
                <span style={{ color: 'var(--text-muted)' }}>({s.snapshot_utc} UTC)</span>
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
