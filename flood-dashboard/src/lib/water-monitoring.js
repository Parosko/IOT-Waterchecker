export const DISTANCE_MIN_CM = 20
export const DISTANCE_MAX_CM = 450
export const READING_LIMIT = 300

export function isValidDistance(value) {
  return value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value))
    && Number(value) >= DISTANCE_MIN_CM
    && Number(value) <= DISTANCE_MAX_CM
}

export function calculateWaterLevel(sensorToBottomCm, distanceCm) {
  const base = Number(sensorToBottomCm)
  if (!Number.isFinite(base) || base <= 0 || !isValidDistance(distanceCm)) return null
  return Math.max(0, base - Number(distanceCm))
}

export function classifyWaterLevel(levelCm, settings) {
  if (!Number.isFinite(levelCm) || !settings) return 'UNKNOWN'
  if (levelCm >= Number(settings.flood_level_cm)) return 'BANJIR'
  if (levelCm >= Number(settings.warning_level_cm)) return 'WASPADA'
  return 'NORMAL'
}

export function validateSettings(settings) {
  const fields = [
    ['sensor_to_bottom_cm', 'Jarak sensor ke dasar saluran'],
    ['warning_level_cm', 'Ambang waspada'],
    ['flood_level_cm', 'Ambang banjir'],
  ]
  const errors = []

  for (const [key, label] of fields) {
    const rawValue = settings?.[key]
    if (rawValue === null || rawValue === undefined || rawValue === '' || !Number.isFinite(Number(rawValue))) {
      errors.push(`${label} harus berupa angka positif.`)
    } else if (Number(rawValue) <= 0) {
      errors.push(`${label} harus lebih besar dari 0 cm.`)
    }
  }

  if (errors.length) return errors

  const sensorToBottom = Number(settings.sensor_to_bottom_cm)
  const warningLevel = Number(settings.warning_level_cm)
  const floodLevel = Number(settings.flood_level_cm)

  if (warningLevel >= floodLevel) {
    errors.push('Ambang waspada harus lebih kecil dari ambang banjir.')
  }
  if (sensorToBottom - floodLevel < 30) {
    errors.push('Jarak sensor saat ambang banjir harus minimal 30 cm. Sensor tidak bisa membaca jarak di bawah 20 cm dan membutuhkan margin.')
  }

  return errors
}

export function summarizeValidDistances(readings) {
  const distances = readings
    .map((reading) => Number(reading.distance_cm))
    .filter((distance) => isValidDistance(distance))
    .sort((left, right) => left - right)

  if (!distances.length) {
    return {
      median: null,
      minimum: null,
      maximum: null,
      spread: null,
      validCount: 0,
    }
  }

  const middle = Math.floor(distances.length / 2)
  const median = distances.length % 2
    ? distances[middle]
    : (distances[middle - 1] + distances[middle]) / 2
  const minimum = distances[0]
  const maximum = distances.at(-1)

  return {
    median,
    minimum,
    maximum,
    spread: maximum - minimum,
    validCount: distances.length,
  }
}

export function compareReadingTime(left, right) {
  const leftTime = new Date(left.created_at).getTime()
  const rightTime = new Date(right.created_at).getTime()
  if (leftTime !== rightTime) return leftTime - rightTime

  const leftId = String(left.id ?? '')
  const rightId = String(right.id ?? '')
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const a = BigInt(leftId)
    const b = BigInt(rightId)
    return a < b ? -1 : a > b ? 1 : 0
  }
  return leftId.localeCompare(rightId)
}

export function mergeReadings(current, incoming, limit = READING_LIMIT) {
  const readingsById = new Map()
  for (const reading of [...current, ...incoming]) {
    if (reading?.id !== null && reading?.id !== undefined) {
      readingsById.set(String(reading.id), reading)
    }
  }

  return [...readingsById.values()]
    .sort(compareReadingTime)
    .slice(-limit)
}
