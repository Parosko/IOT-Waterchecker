import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateWaterLevel,
  classifyWaterLevel,
  mergeReadings,
  summarizeValidDistances,
  validateSettings,
} from './water-monitoring.js'

test('height uses sensor-to-bottom distance and never becomes negative', () => {
  assert.equal(calculateWaterLevel(56, 30), 26)
  assert.equal(calculateWaterLevel(56, 60), 0)
  assert.equal(calculateWaterLevel(56, null), null)
  assert.equal(calculateWaterLevel(56, 19.9), null)
  assert.equal(calculateWaterLevel(56, 450), 0)
})

test('status changes at the inclusive warning and flood thresholds', () => {
  const settings = { warning_level_cm: 18, flood_level_cm: 22 }
  assert.equal(classifyWaterLevel(17.99, settings), 'NORMAL')
  assert.equal(classifyWaterLevel(18, settings), 'WASPADA')
  assert.equal(classifyWaterLevel(21.99, settings), 'WASPADA')
  assert.equal(classifyWaterLevel(22, settings), 'BANJIR')
  assert.equal(classifyWaterLevel(null, settings), 'UNKNOWN')
})

test('settings validation requires positive values and safe threshold geometry', () => {
  const valid = {
    sensor_to_bottom_cm: 56,
    warning_level_cm: 18,
    flood_level_cm: 22,
  }
  assert.deepEqual(validateSettings(valid), [])
  assert.ok(validateSettings({ ...valid, sensor_to_bottom_cm: 0 }).some((message) => message.includes('lebih besar dari 0')))
  assert.ok(validateSettings({ ...valid, warning_level_cm: 22 }).some((message) => message.includes('lebih kecil')))
  assert.ok(validateSettings({ ...valid, sensor_to_bottom_cm: 50 }).some((message) => message.includes('minimal 30 cm')))
  assert.ok(validateSettings({ ...valid, flood_level_cm: 31 }).some((message) => message.includes('minimal 30 cm')))
  assert.ok(validateSettings({ ...valid, warning_level_cm: '' }).length > 0)
})

test('measure-now median ignores invalid distances and reports spread', () => {
  const readings = [
    { distance_cm: 51 },
    { distance_cm: 52 },
    { distance_cm: 53 },
    { distance_cm: null },
    { distance_cm: 19 },
    { distance_cm: 451 },
  ]
  assert.deepEqual(summarizeValidDistances(readings), {
    median: 52,
    minimum: 51,
    maximum: 53,
    spread: 2,
    validCount: 3,
  })
  assert.equal(summarizeValidDistances([{ distance_cm: 30 }, { distance_cm: 34 }]).spread, 4)
  assert.equal(summarizeValidDistances([{ distance_cm: null }]).median, null)
})

test('reading merge deduplicates by id and orders by sample time', () => {
  const merged = mergeReadings(
    [
      { id: 10, created_at: '2026-10-10T00:00:02.000Z', distance_cm: 40 },
      { id: 11, created_at: '2026-10-10T00:00:01.000Z', distance_cm: 41 },
    ],
    [{ id: 10, created_at: '2026-10-10T00:00:02.000Z', distance_cm: 39 }],
  )
  assert.deepEqual(merged.map((reading) => reading.id), [11, 10])
  assert.equal(merged[1].distance_cm, 39)
})
