/**
 * Persist table column filters in sessionStorage so selections survive navigating
 * away from the page and back (same tab).
 */

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function safeStringArray(v: unknown): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : []
}

function writeJson(key: string, value: unknown): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / private mode */
  }
}

const K = {
  renewals: 'dazos.v1.tableFilters.renewals',
  bookings: 'dazos.v1.tableFilters.bookings',
  pipeline: 'dazos.v1.tableFilters.pipeline',
} as const

export type RenewalsTableFilters = {
  stage: string[]
  months: string[]
  midterm: string[]
}

export function loadRenewalsFilters(): RenewalsTableFilters {
  try {
    const s = storage()
    if (!s) return { stage: [], months: [], midterm: [] }
    const raw = s.getItem(K.renewals)
    if (!raw) return { stage: [], months: [], midterm: [] }
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      stage: safeStringArray(p.stage),
      months: safeStringArray(p.months),
      midterm: safeStringArray(p.midterm),
    }
  } catch {
    return { stage: [], months: [], midterm: [] }
  }
}

export function saveRenewalsFilters(f: RenewalsTableFilters): void {
  writeJson(K.renewals, f)
}

export type BookingsTableFilters = {
  stage: string[]
  recordType: string[]
  months: string[]
  chartSlice: { month: string | null; bucket: string } | null
}

function parseBookingsChartSlice(v: unknown): { month: string | null; bucket: string } | null {
  if (v == null) return null
  if (typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const month = o.month === null || typeof o.month === 'string' ? o.month : null
  const bucket = typeof o.bucket === 'string' ? o.bucket : ''
  if (!bucket) return null
  return { month, bucket }
}

export function loadBookingsFilters(): BookingsTableFilters {
  try {
    const s = storage()
    if (!s) return { stage: [], recordType: [], months: [], chartSlice: null }
    const raw = s.getItem(K.bookings)
    if (!raw) return { stage: [], recordType: [], months: [], chartSlice: null }
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      stage: safeStringArray(p.stage),
      recordType: safeStringArray(p.recordType),
      months: safeStringArray(p.months),
      chartSlice: parseBookingsChartSlice(p.chartSlice),
    }
  } catch {
    return { stage: [], recordType: [], months: [], chartSlice: null }
  }
}

export function saveBookingsFilters(f: BookingsTableFilters): void {
  writeJson(K.bookings, f)
}

export type PipelineTableFilters = {
  stage: string[]
  recordType: string[]
  closeDate: string[]
  chartSlice: { month: string | null; stage: string } | null
}

function parsePipelineChartSlice(v: unknown): { month: string | null; stage: string } | null {
  if (v == null) return null
  if (typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const month = o.month === null || typeof o.month === 'string' ? o.month : null
  const st = typeof o.stage === 'string' ? o.stage : ''
  if (!st) return null
  return { month, stage: st }
}

export function loadPipelineFilters(): PipelineTableFilters {
  try {
    const s = storage()
    if (!s) return { stage: [], recordType: [], closeDate: [], chartSlice: null }
    const raw = s.getItem(K.pipeline)
    if (!raw) return { stage: [], recordType: [], closeDate: [], chartSlice: null }
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      stage: safeStringArray(p.stage),
      recordType: safeStringArray(p.recordType),
      closeDate: safeStringArray(p.closeDate),
      chartSlice: parsePipelineChartSlice(p.chartSlice),
    }
  } catch {
    return { stage: [], recordType: [], closeDate: [], chartSlice: null }
  }
}

export function savePipelineFilters(f: PipelineTableFilters): void {
  writeJson(K.pipeline, f)
}
