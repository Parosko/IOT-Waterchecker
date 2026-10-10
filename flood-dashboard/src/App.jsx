import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { supabase } from './lib/supabase.js'
import {
  calculateWaterLevel,
  classifyWaterLevel,
  compareReadingTime,
  isValidDistance,
  mergeReadings,
  summarizeValidDistances,
  validateSettings,
} from './lib/water-monitoring.js'

const POLL_INTERVAL_MS = 3000
const RECENT_SYNC_INTERVAL_MS = 30_000
const RECENT_SYNC_WINDOW_MS = 60_000
const NULL_ERROR_AFTER_MS = 30_000
const DEVICE_OFFLINE_AFTER_MS = 20_000
const READING_COLUMNS = 'id, created_at, distance_cm, water_level_cm, water_sensor_value, water_limit_reached'
const DEFAULT_SETTINGS = Object.freeze({
  is_configured: false,
  sensor_to_bottom_cm: '56',
  warning_level_cm: '18',
  flood_level_cm: '22',
})

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const number = Number(value)
  return Number.isFinite(number)
    ? number.toLocaleString('id-ID', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : '--'
}

function mergeLatestValidReading(current, incoming) {
  const valid = incoming.filter((reading) => isValidDistance(reading.distance_cm))
  if (current && isValidDistance(current.distance_cm)) valid.push(current)
  valid.sort(compareReadingTime)
  return valid.at(-1) ?? null
}

function formatTimestamp(value) {
  if (!value) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '--'
    : date.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'medium',
        timeStyle: 'medium',
      })
}

function getSettingsDraft(settings) {
  if (!settings) return { ...DEFAULT_SETTINGS }
  return {
    is_configured: Boolean(settings.is_configured),
    sensor_to_bottom_cm: String(settings.sensor_to_bottom_cm ?? 56),
    warning_level_cm: String(settings.warning_level_cm ?? 18),
    flood_level_cm: String(settings.flood_level_cm ?? 22),
  }
}

function getLatestReading(readings) {
  return readings.at(-1) ?? null
}

function getLatestValidReading(readings) {
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    if (isValidDistance(readings[index].distance_cm)) return readings[index]
  }
  return null
}

function getSensorErrorStart(readings) {
  if (!readings.length || isValidDistance(getLatestReading(readings).distance_cm)) return null
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    if (isValidDistance(readings[index].distance_cm)) {
      return readings[index + 1]?.created_at ?? getLatestReading(readings).created_at
    }
  }
  return readings[0].created_at
}

function getLargestId(readings, current = '0') {
  return readings.reduce((largest, reading) => {
    const id = String(reading.id)
    return /^\d+$/.test(id) && BigInt(id) > BigInt(largest) ? id : largest
  }, current)
}

function getChartGeometry(points, maxLevel) {
  const left = 60
  const right = 952
  const top = 18
  const bottom = 218
  const firstTime = points.length ? new Date(points[0].created_at).getTime() : 0
  const lastTime = points.length ? new Date(points.at(-1).created_at).getTime() : 0
  const duration = Math.max(lastTime - firstTime, 1)
  const segments = []
  let activeSegment = []
  let previousTime = null

  for (const point of points) {
    const time = new Date(point.created_at).getTime()
    if (point.value === null || !Number.isFinite(point.value)
      || (previousTime !== null && time - previousTime > 2500)) {
      if (activeSegment.length) segments.push(activeSegment)
      activeSegment = []
    }

    if (Number.isFinite(point.value)) {
      const x = left + ((time - firstTime) / duration) * (right - left)
      const y = bottom - (point.value / maxLevel) * (bottom - top)
      activeSegment.push({ x, y, point })
    }
    previousTime = time
  }
  if (activeSegment.length) segments.push(activeSegment)

  return {
    left,
    right,
    top,
    bottom,
    segments,
    paths: segments.map((segment) => segment
      .map((item, index) => `${index ? 'L' : 'M'} ${item.x.toFixed(2)} ${item.y.toFixed(2)}`)
      .join(' ')),
  }
}

function WaterChart({ readings, settings }) {
  const points = readings.map((reading) => ({
    created_at: reading.created_at,
    value: isValidDistance(reading.distance_cm)
      ? calculateWaterLevel(settings.sensor_to_bottom_cm, reading.distance_cm)
      : null,
  }))
  const maxLevel = Math.max(
    1,
    Number(settings.flood_level_cm),
    ...points.map((point) => Number.isFinite(point.value) ? point.value : 0),
  )
  const chart = getChartGeometry(points, maxLevel)
  const warningY = chart.bottom - (Number(settings.warning_level_cm) / maxLevel) * (chart.bottom - chart.top)
  const floodY = chart.bottom - (Number(settings.flood_level_cm) / maxLevel) * (chart.bottom - chart.top)

  return (
    <div className="chart-card">
      <div className="chart-heading">
        <div>
          <h3>Tinggi air · 300 pembacaan terakhir</h3>
          <p>Air naik = garis naik. Waktu ditampilkan dalam WIB.</p>
        </div>
        <span className="chart-unit">cm</span>
      </div>
      {!points.length ? (
        <p className="chart-empty">Belum ada data pengukuran.</p>
      ) : (
        <div className="chart-scroll">
          <svg className="water-chart" viewBox="0 0 980 254" role="img" aria-label="Grafik tinggi air">
            {[0, maxLevel / 2, maxLevel].map((tick) => {
              const y = chart.bottom - (tick / maxLevel) * (chart.bottom - chart.top)
              return (
                <g key={tick}>
                  <line x1={chart.left} x2={chart.right} y1={y} y2={y} className="chart-grid-line" />
                  <text x="50" y={y + 4} className="chart-axis-label" textAnchor="end">{formatNumber(tick, 0)}</text>
                </g>
              )
            })}
            <line x1={chart.left} x2={chart.left} y1={chart.top} y2={chart.bottom} className="chart-axis-line" />
            <line x1={chart.left} x2={chart.right} y1={chart.bottom} y2={chart.bottom} className="chart-axis-line" />
            <line x1={chart.left} x2={chart.right} y1={warningY} y2={warningY} className="chart-threshold chart-threshold-warning" />
            <line x1={chart.left} x2={chart.right} y1={floodY} y2={floodY} className="chart-threshold chart-threshold-flood" />
            <text x={chart.right - 4} y={warningY - 5} textAnchor="end" className="chart-threshold-label chart-warning-label">
              Waspada {formatNumber(settings.warning_level_cm, 1)} cm
            </text>
            <text x={chart.right - 4} y={floodY - 5} textAnchor="end" className="chart-threshold-label chart-flood-label">
              Banjir {formatNumber(settings.flood_level_cm, 1)} cm
            </text>
            {chart.paths.map((path, index) => <path key={index} d={path} className="chart-series" />)}
            {chart.segments.flatMap((segment) => segment.map(({ x, y, point }, index) => (
              <circle key={`${point.created_at}-${index}`} cx={x} cy={y} r={points.length > 100 ? 1.7 : 3} className="chart-point">
                <title>{`${formatTimestamp(point.created_at)} · ${formatNumber(point.value)} cm`}</title>
              </circle>
            )))}
            <text x={chart.left} y="244" className="chart-axis-label">
              {points.length ? new Date(points[0].created_at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) : ''}
            </text>
            <text x={chart.right} y="244" textAnchor="end" className="chart-axis-label">
              {points.length ? new Date(points.at(-1).created_at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) : ''}
            </text>
          </svg>
        </div>
      )}
      <p className="chart-gap-note">Celah menunjukkan sensor gagal membaca atau ada jeda sampel.</p>
    </div>
  )
}

function LevelIllustration({ sensorToBottomCm, warningLevelCm, floodLevelCm }) {
  const sensorToBottom = Number(sensorToBottomCm)
  const warningLevel = Number(warningLevelCm)
  const floodLevel = Number(floodLevelCm)
  const validBase = Number.isFinite(sensorToBottom) && sensorToBottom > 0
  const warningY = validBase
    ? 258 - (Math.min(Math.max(warningLevel, 0), sensorToBottom) / sensorToBottom) * 190
    : 220
  const floodY = validBase
    ? 258 - (Math.min(Math.max(floodLevel, 0), sensorToBottom) / sensorToBottom) * 190
    : 175
  const numberLabel = (value) => Number.isFinite(value) && value > 0 ? formatNumber(value, 1) : '--'

  return (
    <svg
      className="level-illustration"
      viewBox="0 0 500 320"
      role="img"
      aria-label={`Jarak sensor ke dasar ${numberLabel(sensorToBottom)} cm; ambang waspada ${numberLabel(warningLevel)} cm tinggi air; ambang banjir ${numberLabel(floodLevel)} cm tinggi air`}
    >
      <defs>
        <marker id="dimension-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="dimension-arrow-head" />
        </marker>
      </defs>
      <text x="130" y="18" textAnchor="middle" className="diagram-caption">JARAK SENSOR KE DASAR</text>
      <rect x="87" y="54" width="92" height="204" rx="5" className="channel" />
      <rect x="93" y={floodY} width="80" height={Math.max(0, 258 - floodY)} className="illustration-water" />
      <line x1="87" x2="179" y1={warningY} y2={warningY} className="illustration-warning-line" />
      <line x1="87" x2="179" y1={floodY} y2={floodY} className="illustration-flood-line" />
      <rect x="111" y="33" width="44" height="17" rx="4" className="illustration-sensor" />
      <path d="M133 51 L133 61 M129 57 L133 62 L137 57" className="illustration-measure" />
      <line x1="68" x2="68" y1="56" y2="256" className="sensor-distance-line" markerStart="url(#dimension-arrow)" markerEnd="url(#dimension-arrow)" />
      <rect x="4" y="139" width="59" height="39" rx="6" className="distance-value-box" />
      <text x="33.5" y="153" textAnchor="middle" className="distance-value-caption">TOTAL</text>
      <text x="33.5" y="169" textAnchor="middle" className="distance-value-text">{numberLabel(sensorToBottom)} cm</text>
      <line x1="77" x2="188" y1="258" y2="258" className="illustration-bottom" />
      <polyline points={`179,${floodY} 202,${floodY} 214,82 226,82`} className="flood-connector" />
      <polyline points={`179,${warningY} 202,${warningY} 214,202 226,202`} className="warning-connector" />
      <rect x="226" y="42" width="265" height="82" rx="9" className="diagram-flood-card" />
      <text x="241" y="64" className="diagram-card-label flood-text">AMBANG BANJIR</text>
      <text x="241" y="88" className="diagram-card-value">{numberLabel(floodLevel)} cm tinggi air</text>
      <text x="241" y="108" className="diagram-card-detail">
        Sensor membaca {validBase && Number.isFinite(floodLevel) ? numberLabel(sensorToBottom - floodLevel) : '--'} cm
      </text>
      <rect x="226" y="162" width="265" height="82" rx="9" className="diagram-warning-card" />
      <text x="241" y="184" className="diagram-card-label warning-text">AMBANG WASPADA</text>
      <text x="241" y="208" className="diagram-card-value">{numberLabel(warningLevel)} cm tinggi air</text>
      <text x="241" y="228" className="diagram-card-detail">
        Sensor membaca {validBase && Number.isFinite(warningLevel) ? numberLabel(sensorToBottom - warningLevel) : '--'} cm
      </text>
      <text x="133" y="279" textAnchor="middle" className="illustration-label">DASAR SALURAN</text>
      <text x="133" y="299" textAnchor="middle" className="diagram-scale-caption">Garis putus-putus menunjukkan tinggi air</text>
    </svg>
  )
}

function SettingsForm({ initialSettings, saving, onSave, onCancel, showCancel }) {
  const [draft, setDraft] = useState(() => getSettingsDraft(initialSettings))
  const [measureState, setMeasureState] = useState({ loading: false, error: '' })
  const validation = useMemo(() => validateSettings(draft), [draft])

  function updateField(name, value) {
    setDraft((current) => ({ ...current, [name]: value }))
  }

  async function measureNow() {
    if (!supabase) {
      setMeasureState({ loading: false, error: 'Konfigurasi Supabase belum tersedia.' })
      return
    }
    setMeasureState({ loading: true, error: '' })

    try {
      const since = new Date(Date.now() - 30_000).toISOString()
      const { data, error } = await supabase
        .from('water_readings')
        .select('created_at, distance_cm')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500)

      if (error) {
        setMeasureState({ loading: false, error: `Gagal mengukur sekarang: ${error.message}` })
        return
      }

      const samples = data ?? []
      const newest = samples.reduce((latest, reading) => (
        !latest || new Date(reading.created_at) > new Date(latest.created_at) ? reading : latest
      ), null)
      if (!newest || Date.now() - new Date(newest.created_at).getTime() > DEVICE_OFFLINE_AFTER_MS) {
        setMeasureState({
          loading: false,
          error: 'Perangkat terputus: tidak ada sampel dalam 20 detik terakhir. Periksa koneksi sensor dan coba lagi.',
        })
        return
      }

      const summary = summarizeValidDistances(samples)
      if (summary.validCount < 5) {
        setMeasureState({
          loading: false,
          error: `Pembacaan valid kurang dari 5 (ditemukan ${summary.validCount}). Lakukan saat saluran kosong atau saat air di titik terendah.`,
        })
        return
      }
      if (summary.spread > 3) {
        setMeasureState({
          loading: false,
          error: `Pembacaan belum stabil (rentang ${formatNumber(summary.spread)} cm). Lakukan saat saluran kosong atau saat air di titik terendah.`,
        })
        return
      }

      updateField('sensor_to_bottom_cm', String(summary.median))
      setMeasureState({ loading: false, error: '' })
    } catch (error) {
      setMeasureState({
        loading: false,
        error: `Gagal mengukur sekarang: ${error.message ?? 'Kesalahan jaringan.'}`,
      })
    }
  }

  function submit(event) {
    event.preventDefault()
    if (validation.length) return
    onSave({
      sensor_to_bottom_cm: Number(draft.sensor_to_bottom_cm),
      warning_level_cm: Number(draft.warning_level_cm),
      flood_level_cm: Number(draft.flood_level_cm),
    })
  }

  const sensorToBottom = Number(draft.sensor_to_bottom_cm)
  const warningLevel = Number(draft.warning_level_cm)
  const floodLevel = Number(draft.flood_level_cm)
  const safePreview = sensorToBottom > 0 && warningLevel > 0 && floodLevel > 0

  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="setup-layout">
        <div className="settings-fields">
          <label className="settings-field">
            <span>Jarak sensor ke dasar saluran (cm)</span>
            <small>Jarak dari sensor hingga dasar saat saluran kosong atau air berada di titik terendah.</small>
            <span className="measure-row">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={draft.sensor_to_bottom_cm}
                onChange={(event) => updateField('sensor_to_bottom_cm', event.target.value)}
              />
              <button type="button" className="secondary-button" onClick={measureNow} disabled={measureState.loading}>
                {measureState.loading ? 'Mengukur...' : 'Ukur sekarang'}
              </button>
            </span>
          </label>
          <label className="settings-field">
            <span>Ambang waspada: tinggi air (cm)</span>
            <small>Tampilkan peringatan saat tinggi air mencapai nilai ini.</small>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={draft.warning_level_cm}
              onChange={(event) => updateField('warning_level_cm', event.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>Ambang banjir: tinggi air (cm)</span>
            <small>Status banjir saat tinggi air mencapai nilai ini.</small>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={draft.flood_level_cm}
              onChange={(event) => updateField('flood_level_cm', event.target.value)}
            />
          </label>
        </div>
        <LevelIllustration
          sensorToBottomCm={draft.sensor_to_bottom_cm}
          warningLevelCm={draft.warning_level_cm}
          floodLevelCm={draft.flood_level_cm}
        />
      </div>

      <div className="settings-preview" aria-live="polite">
        {safePreview ? (
          <>
            <p>Saat air mencapai <strong>{formatNumber(floodLevel, 1)} cm</strong>, sensor akan membaca jarak <strong>{formatNumber(sensorToBottom - floodLevel, 1)} cm</strong>.</p>
            <p>Saat air mencapai <strong>{formatNumber(warningLevel, 1)} cm</strong>, sensor akan membaca jarak <strong>{formatNumber(sensorToBottom - warningLevel, 1)} cm</strong>.</p>
          </>
        ) : (
          <p>Isi ketiga nilai dengan angka positif untuk melihat pratinjau.</p>
        )}
      </div>

      {measureState.error && <p className="form-error" role="alert">{measureState.error}</p>}
      {validation.length > 0 && (
        <div className="settings-validation" role="alert">
          <strong>Periksa pengaturan berikut:</strong>
          <ul>{validation.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      )}
      <div className="settings-actions">
        {showCancel && <button type="button" className="secondary-button" onClick={onCancel}>Batal</button>}
        <button type="submit" disabled={saving || validation.length > 0}>
          {saving ? 'Menyimpan...' : 'Simpan pengaturan'}
        </button>
      </div>
    </form>
  )
}

function PredictionCard({ prediction }) {
  return (
    <article className="metric-card prediction-card">
      <h2>Prediksi</h2>
      {prediction ? (
        <p className="prediction-value">{prediction.label ?? 'Prediksi tersedia'}</p>
      ) : (
        <p className="prediction-value">Prediksi belum aktif</p>
      )}
      <p className="metric-caption">Peringatan model prediksi akan ditambahkan kemudian.</p>
    </article>
  )
}

function App() {
  const [readings, setReadings] = useState([])
  const [lastValidReading, setLastValidReading] = useState(null)
  const [settings, setSettings] = useState(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsMessage, setSettingsMessage] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [editingSettings, setEditingSettings] = useState(false)
  const [loadingReadings, setLoadingReadings] = useState(true)
  const [readingsError, setReadingsError] = useState('')
  const [now, setNow] = useState(0)

  const largestIdRef = useRef('0')
  const pollBusyRef = useRef(false)

  const latestReading = getLatestReading(readings)
  const latestValidReading = lastValidReading ?? getLatestValidReading(readings)
  const sensorErrorStart = getSensorErrorStart(readings)
  const sensorProblem = Boolean(
    sensorErrorStart && now - new Date(sensorErrorStart).getTime() > NULL_ERROR_AFTER_MS,
  )
  const latestReadingAge = latestReading ? now - new Date(latestReading.created_at).getTime() : null
  const deviceDisconnected = latestReadingAge === null || latestReadingAge > DEVICE_OFFLINE_AFTER_MS
  const currentLevel = settings && latestValidReading
    ? calculateWaterLevel(settings.sensor_to_bottom_cm, latestValidReading.distance_cm)
    : null
  const currentStatus = currentLevel === null || !settings
    ? 'UNKNOWN'
    : classifyWaterLevel(currentLevel, settings)
  const remainingToFlood = currentLevel === null
    ? null
    : Number(settings.flood_level_cm) - currentLevel

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true

    async function loadSettings() {
      if (!supabase) {
        setSettingsError('Konfigurasi Supabase belum diisi. Lengkapi VITE_SUPABASE_URL dan VITE_SUPABASE_KEY.')
        setSettingsLoaded(true)
        return
      }

      try {
        const { data, error } = await supabase
          .from('device_settings')
          .select('id, is_configured, sensor_to_bottom_cm, warning_level_cm, flood_level_cm, updated_at')
          .eq('id', 1)
          .maybeSingle()
        if (!active) return

        if (error) {
          setSettingsError(`Gagal membaca pengaturan: ${error.message}`)
          setSettingsLoaded(true)
          return
        }
        if (!data) {
          setSettingsError('Baris pengaturan id=1 belum tersedia di public.device_settings. Buat baris tersebut di Supabase sebelum melanjutkan.')
          setSettingsLoaded(true)
          return
        }

        setSettings(data)
        setSettingsError('')
        setSettingsLoaded(true)
      } catch (error) {
        if (active) {
          setSettingsError(`Gagal membaca pengaturan: ${error.message ?? 'Kesalahan jaringan.'}`)
          setSettingsLoaded(true)
        }
      }
    }

    loadSettings()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!settings?.is_configured || !supabase) return undefined
    let active = true
    let pollTimer
    let syncTimer
    let initialRequest = true
    pollBusyRef.current = false

    async function loadInitial() {
      try {
        const [recentResult, validResult] = await Promise.all([
          supabase
            .from('water_readings')
            .select(READING_COLUMNS)
            .order('created_at', { ascending: false })
            .limit(300),
          supabase
            .from('water_readings')
            .select(READING_COLUMNS)
            .not('distance_cm', 'is', null)
            .gte('distance_cm', 20)
            .lte('distance_cm', 450)
            .order('created_at', { ascending: false })
            .limit(1),
        ])

        if (!active) return
        if (recentResult.error || validResult.error) {
          const error = recentResult.error ?? validResult.error
          setReadingsError(`Gagal mengambil data pembacaan: ${error.message}`)
          return
        }

        const batch = recentResult.data ?? []
        largestIdRef.current = getLargestId(batch)
        setReadings(mergeReadings([], batch))
        setLastValidReading(mergeLatestValidReading(null, validResult.data ?? []))
        setReadingsError('')
      } catch (error) {
        if (active) setReadingsError(`Gagal mengambil data pembacaan: ${error.message ?? 'Kesalahan jaringan.'}`)
      } finally {
        if (active) {
          initialRequest = false
          setLoadingReadings(false)
        }
      }
    }

    async function pollById() {
      if (!active || initialRequest || pollBusyRef.current) return
      pollBusyRef.current = true
      try {
        const { data, error } = await supabase
          .from('water_readings')
          .select(READING_COLUMNS)
          .gt('id', largestIdRef.current)
          .order('id', { ascending: true })
          .limit(500)
        if (!active) return
        if (error) {
          setReadingsError(`Gagal mengambil pembacaan baru: ${error.message}`)
          return
        }

        const batch = data ?? []
        largestIdRef.current = getLargestId(batch, largestIdRef.current)
        if (batch.length) {
          setReadings((current) => mergeReadings(current, batch))
          setLastValidReading((current) => mergeLatestValidReading(current, batch))
        }
        setReadingsError('')
      } catch (error) {
        if (active) setReadingsError(`Gagal mengambil pembacaan baru: ${error.message ?? 'Kesalahan jaringan.'}`)
      } finally {
        pollBusyRef.current = false
      }
    }

    async function synchronizeRecentWindow() {
      if (!active || initialRequest) return
      try {
        const from = new Date(Date.now() - RECENT_SYNC_WINDOW_MS).toISOString()
        const { data, error } = await supabase
          .from('water_readings')
          .select(READING_COLUMNS)
          .gte('created_at', from)
          .order('created_at', { ascending: false })
          .limit(500)
        if (!active) return
        if (error) {
          setReadingsError(`Gagal menyinkronkan data terbaru: ${error.message}`)
          return
        }

        const batch = data ?? []
        largestIdRef.current = getLargestId(batch, largestIdRef.current)
        if (batch.length) {
          setReadings((current) => mergeReadings(current, batch))
          setLastValidReading((current) => mergeLatestValidReading(current, batch))
        }
        setReadingsError('')
      } catch (error) {
        if (active) setReadingsError(`Gagal menyinkronkan data terbaru: ${error.message ?? 'Kesalahan jaringan.'}`)
      }
    }

    loadInitial()
    pollTimer = window.setInterval(pollById, POLL_INTERVAL_MS)
    syncTimer = window.setInterval(synchronizeRecentWindow, RECENT_SYNC_INTERVAL_MS)

    return () => {
      active = false
      window.clearInterval(pollTimer)
      window.clearInterval(syncTimer)
      pollBusyRef.current = false
    }
  }, [settings?.is_configured])

  async function saveSettings(values) {
    if (!supabase || !settings) return
    setSavingSettings(true)
    setSettingsMessage('')
    setSettingsError('')

    try {
      const { data, error } = await supabase
        .from('device_settings')
        .update({
          ...values,
          is_configured: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1)
        .select('id, is_configured, sensor_to_bottom_cm, warning_level_cm, flood_level_cm, updated_at')
        .single()
      if (error) {
        setSettingsError(`Pengaturan gagal disimpan: ${error.message}`)
        return
      }

      setSettings(data)
      setEditingSettings(false)
      setSettingsMessage('Pengaturan berhasil disimpan.')
    } catch (error) {
      setSettingsError(`Pengaturan gagal disimpan: ${error.message ?? 'Kesalahan jaringan.'}`)
    } finally {
      setSavingSettings(false)
    }
  }

  if (!settingsLoaded) {
    return <main className="dashboard"><p className="table-message">Memuat pengaturan perangkat...</p></main>
  }

  if (!settings) {
    return (
      <main className="dashboard">
        <div className="notice notice-error" role="alert">{settingsError}</div>
      </main>
    )
  }

  if (!settings.is_configured || editingSettings) {
    const firstSetup = !settings.is_configured
    return (
      <main className="dashboard setup-page">
        <header className="page-header">
          <div>
            <p className="eyebrow">{firstSetup ? 'Pengaturan awal' : 'Pengaturan perangkat'}</p>
            <h1>{firstSetup ? 'Siapkan Pemantauan Air' : 'Pengaturan Sensor dan Ambang'}</h1>
            <p className="subtitle">Isi jarak sensor dan ambang tinggi air untuk mulai memantau.</p>
          </div>
        </header>
        {settingsError && <div className="notice notice-error" role="alert">{settingsError}</div>}
        <section className="settings-section setup-card" aria-label="Pengaturan sensor">
          <SettingsForm
            key={`${settings.id}-${settings.is_configured}-${editingSettings}`}
            initialSettings={settings}
            saving={savingSettings}
            onSave={saveSettings}
            onCancel={() => setEditingSettings(false)}
            showCancel={!firstSetup}
          />
        </section>
      </main>
    )
  }

  const statusLabel = {
    NORMAL: 'NORMAL',
    WASPADA: 'WASPADA',
    BANJIR: 'BANJIR',
    UNKNOWN: 'MENUNGGU PEMBACAAN VALID',
  }[currentStatus]
  const statusClass = {
    NORMAL: 'status-normal',
    WASPADA: 'status-waspada',
    BANJIR: 'status-banjir',
    UNKNOWN: 'status-unknown',
  }[currentStatus]

  return (
    <main className="dashboard">
      <header className="page-header">
        <div>
          <p className="eyebrow">Pemantauan sensor</p>
          <h1>Water Level Monitoring</h1>
          <p className="subtitle">ESP32 Flood Detection Prototype</p>
        </div>
        <div className="last-reading" aria-live="polite">
          <span className="last-reading-label">Waktu sampel terakhir (WIB)</span>
          <strong>{formatTimestamp(latestReading?.created_at)}</strong>
          <span className={`connection-state ${deviceDisconnected ? 'connection-offline' : 'connection-online'}`}>
            {deviceDisconnected ? 'TERPUTUS' : 'TERHUBUNG'}
          </span>
        </div>
      </header>

      {readingsError && <div className="notice notice-error" role="alert">{readingsError}</div>}
      {settingsError && <div className="notice notice-error" role="alert">{settingsError}</div>}
      {settingsMessage && <div className="notice notice-success" role="status">{settingsMessage}</div>}
      {sensorProblem && <div className="sensor-warning" role="status">SENSOR BERMASALAH — tidak ada pembacaan valid lebih dari 30 detik. Status terakhir dipertahankan.</div>}
      {currentStatus === 'WASPADA' && (
        <div className="status-banner banner-warning" role="status">
          <strong>WASPADA</strong>
          <span>Tinggi air telah mencapai ambang waspada.</span>
        </div>
      )}
      {currentStatus === 'BANJIR' && (
        <div className="status-banner banner-flood" role="alert">
          <strong>BANJIR</strong>
          <span>Tinggi air telah mencapai ambang banjir. Segera periksa kondisi saluran.</span>
        </div>
      )}

      <section className="monitoring-grid" aria-label="Ringkasan pemantauan">
        <article className="metric-card">
          <h2>Tinggi Air Terkini</h2>
          <p className="metric-value">{currentLevel === null ? 'Sensor error' : <>{formatNumber(currentLevel)} <span>cm</span></>}</p>
          <p className="metric-caption">Tinggi terukur dari dasar saluran</p>
        </article>
        <article className="metric-card">
          <h2>Jarak Sensor Mentah</h2>
          <p className="metric-value">
            {latestValidReading ? <>{formatNumber(latestValidReading.distance_cm)} <span>cm</span></> : 'Sensor error'}
          </p>
          <p className="metric-caption">Rentang valid sensor: 20–450 cm</p>
        </article>
        <article className="metric-card">
          <h2>Status Saat Ini</h2>
          <p className={`status-value ${statusClass}`}>{statusLabel}</p>
          <p className="metric-caption">
            {currentLevel === null
              ? 'Menunggu pembacaan jarak yang valid'
              : `Waspada ≥ ${formatNumber(settings.warning_level_cm, 1)} cm · Banjir ≥ ${formatNumber(settings.flood_level_cm, 1)} cm`}
          </p>
        </article>
        <article className="metric-card">
          <h2>Sisa ke Ambang Banjir</h2>
          <p className="metric-value">
            {remainingToFlood === null
              ? 'Sensor error'
              : remainingToFlood < 0
                ? 'Melewati ambang banjir'
                : <>{formatNumber(remainingToFlood)} <span>cm</span></>}
          </p>
          <p className="metric-caption">Jarak tinggi air dari ambang banjir</p>
        </article>
        <PredictionCard prediction={null} />
        <article className="metric-card">
          <h2>Status Batas Air Fisik</h2>
          {latestReading?.water_limit_reached === true ? (
            <p className="status-value status-banjir">BATAS AIR TERCAPAI</p>
          ) : latestReading?.water_limit_reached === false ? (
            <p className="status-value status-normal">NORMAL</p>
          ) : (
            <p className="status-value status-unknown">--</p>
          )}
          <p className="metric-caption">Indikator sensor air terpisah</p>
        </article>
        <article className="metric-card">
          <h2>Water Sensor</h2>
          <p className="metric-value">{formatNumber(latestReading?.water_sensor_value, 0)}</p>
          <p className="metric-caption">Nilai pembacaan ADC mentah</p>
        </article>
      </section>

      <section className="chart-section" aria-labelledby="chart-title">
        <div className="section-heading">
          <div>
            <h2 id="chart-title">Grafik Tinggi Air</h2>
            <p>300 pembacaan terbaru dan ambang status.</p>
          </div>
          <span className="refresh-label">Polling setiap 3 detik</span>
        </div>
        <WaterChart readings={readings} settings={settings} />
      </section>

      <section className="history-section" aria-labelledby="history-title">
        <div className="section-heading">
          <div>
            <h2 id="history-title">Pembacaan Terbaru</h2>
            <p>Sepuluh pembacaan sensor terbaru.</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => setEditingSettings(true)}>Pengaturan</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Waktu pengukuran (WIB)</th>
                <th>Jarak sensor (cm)</th>
                <th>Tinggi air (hasil website)</th>
                <th>Nilai dari perangkat (cm)</th>
                <th>Nilai water sensor</th>
                <th>Status batas air</th>
              </tr>
            </thead>
            <tbody>
              {[...readings].reverse().slice(0, 10).map((reading) => (
                <tr key={reading.id}>
                  <td>{formatTimestamp(reading.created_at)}</td>
                  <td>{isValidDistance(reading.distance_cm) ? formatNumber(reading.distance_cm) : 'Sensor error'}</td>
                  <td>
                    {isValidDistance(reading.distance_cm)
                      ? formatNumber(calculateWaterLevel(settings.sensor_to_bottom_cm, reading.distance_cm))
                      : 'Sensor error'}
                  </td>
                  <td>{reading.water_level_cm == null ? 'Sensor error' : formatNumber(reading.water_level_cm)}</td>
                  <td>{formatNumber(reading.water_sensor_value, 0)}</td>
                  <td>
                    {reading.water_limit_reached === true ? (
                      <span className="table-status status-banjir">BATAS AIR TERCAPAI</span>
                    ) : reading.water_limit_reached === false ? (
                      <span className="table-status status-normal">NORMAL</span>
                    ) : (
                      <span className="table-status status-unknown">--</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loadingReadings && <p className="table-message">Memuat data pengukuran...</p>}
          {!loadingReadings && !readingsError && readings.length === 0 && (
            <p className="table-message">Belum ada data pengukuran.</p>
          )}
          {!loadingReadings && readingsError && readings.length === 0 && (
            <p className="table-message">Data belum dapat ditampilkan.</p>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
