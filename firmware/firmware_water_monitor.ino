/*
  Water Level Monitoring - ESP32 + AJ-SR04M -> Supabase

  Perbedaan utama dari versi awal:
  1. Sampling tepat 1 detik (sesuai data training model), bukan 5 detik + lama kirim.
  2. Tiap sampel = median dari 5 pembacaan cepat (meredam spike ultrasonik).
  3. Tiap sampel diberi cap waktu NTP (UTC, presisi milidetik) dan dikirim di kolom created_at.
  4. Sampel dikirim berkelompok tiap ~5 detik oleh task terpisah, jadi lama kirim
     tidak mengganggu jadwal sampling.
  5. Kalau WiFi/Supabase gagal, sampel disimpan di memori (sampai 5 menit) lalu dikirim ulang.

  Tabel public.water_readings TIDAK berubah.
  Syarat di Supabase: RLS mengizinkan INSERT untuk key yang dipakai di sini.
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include <sys/time.h>
#include <math.h>

// =========================
// WIFI
// =========================
const char* WIFI_SSID = "Biznet";
const char* WIFI_PASSWORD = "12345678";

// =========================
// SUPABASE
// =========================
const char* SUPABASE_URL = "https://fffvvleerdxqafltlbdb.supabase.co";
const char* SUPABASE_KEY = "sb_publishable_CLe87T64X_6CnGUdcI2OSg_nG53z45q";   // gunakan anon/publishable key, BUKAN service role key
const char* TABLE_PATH   = "/rest/v1/water_readings";

// =========================
// PIN
// =========================
#define TRIG_PIN  5
#define ECHO_PIN  18      // PERHATIAN: echo AJ-SR04M bisa 5V, ESP32 hanya toleran 3,3V (pakai pembagi tegangan)
#define WATER_PIN 34

// =========================
// GEOMETRI PEMASANGAN (cm)
// =========================
const float TINGGI_WADAH          = 26.0;   // dasar wadah sampai bibir
const float JARAK_SENSOR_KE_BIBIR = 30.0;   // sensor sampai bibir wadah
const float H_PASANG = TINGGI_WADAH + JARAK_SENSOR_KE_BIBIR;  // sensor sampai dasar = 56 cm

// =========================
// SENSOR
// =========================
const float BLIND_ZONE_CM = 20.0;    // di bawah ini pembacaan tidak valid (sama dengan generator data)
const float MAX_RANGE_CM  = 450.0;
const int   READINGS_PER_SAMPLE = 5; // jumlah pembacaan cepat per sampel
const int   MIN_VALID_READINGS  = 3; // minimal pembacaan valid agar sampel dianggap valid
const int   READING_GAP_MS      = 60;
const int   BATAS_WATER = 800;       // water sensor (tidak dipakai model)

// =========================
// JADWAL
// =========================
const uint32_t SAMPLE_INTERVAL_MS = 1000;  // JANGAN diubah tanpa melatih ulang model
const uint32_t UPLOAD_INTERVAL_MS = 5000;
const int      MAX_BATCH   = 30;           // maks sampel per request
const int      BUFFER_SIZE = 300;          // 5 menit data bila offline

// =========================
// BUFFER SAMPEL
// =========================
struct Sample {
  uint32_t seq;
  uint64_t epochMs;
  float distance;      // cm, hanya bermakna bila valid
  int waterValue;
  bool limitReached;
  bool valid;
};

Sample buffer[BUFFER_SIZE];
int bufHead = 0;       // indeks sampel tertua
int bufCount = 0;
uint32_t nextSeq = 0;
SemaphoreHandle_t bufMutex;

uint32_t nextSampleMs = 0;

// ------------------------------------------------------------
// Pembacaan jarak
// ------------------------------------------------------------
float readDistanceOnce() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long dur = pulseIn(ECHO_PIN, HIGH, 30000);  // timeout 30 ms (> 450 cm)
  if (dur == 0) return -1;
  return dur * 0.0343f / 2.0f;
}

// Median dari beberapa pembacaan valid. Return NAN bila terlalu sedikit yang valid.
float readDistanceMedian() {
  float v[READINGS_PER_SAMPLE];
  int n = 0;
  for (int i = 0; i < READINGS_PER_SAMPLE; i++) {
    float d = readDistanceOnce();
    if (d > BLIND_ZONE_CM && d < MAX_RANGE_CM) v[n++] = d;
    delay(READING_GAP_MS);
  }
  if (n < MIN_VALID_READINGS) return NAN;

  for (int i = 1; i < n; i++) {            // insertion sort
    float key = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > key) { v[j + 1] = v[j]; j--; }
    v[j + 1] = key;
  }
  if (n % 2 == 1) return v[n / 2];
  return (v[n / 2 - 1] + v[n / 2]) / 2.0f;
}

// ------------------------------------------------------------
// Buffer
// ------------------------------------------------------------
void pushSample(const Sample& s) {
  xSemaphoreTake(bufMutex, portMAX_DELAY);
  if (bufCount == BUFFER_SIZE) {           // penuh: buang yang tertua
    bufHead = (bufHead + 1) % BUFFER_SIZE;
    bufCount--;
  }
  buffer[(bufHead + bufCount) % BUFFER_SIZE] = s;
  bufCount++;
  xSemaphoreGive(bufMutex);
}

// ------------------------------------------------------------
// Format waktu ISO 8601 UTC dengan milidetik
// ------------------------------------------------------------
void formatIso(uint64_t epochMs, char* out, size_t size) {
  time_t sec = (time_t)(epochMs / 1000ULL);
  struct tm t;
  gmtime_r(&sec, &t);
  size_t n = strftime(out, size, "%Y-%m-%dT%H:%M:%S", &t);
  snprintf(out + n, size - n, ".%03uZ", (unsigned)(epochMs % 1000ULL));
}

// ------------------------------------------------------------
// Task pengiriman (berjalan terpisah dari sampling)
// ------------------------------------------------------------
void uploadTask(void* param) {
  WiFiClientSecure client;
  client.setInsecure();   // MVP: tanpa verifikasi sertifikat. Untuk produksi pakai setCACert().
  HTTPClient http;
  String url = String(SUPABASE_URL) + TABLE_PATH;

  bool more = false;
  for (;;) {
    if (!more) vTaskDelay(pdMS_TO_TICKS(UPLOAD_INTERVAL_MS));
    more = false;

    if (WiFi.status() != WL_CONNECTED) {
      WiFi.reconnect();
      continue;
    }

    // salin batch dari buffer (tanpa menghapus dulu)
    Sample batch[MAX_BATCH];
    int n = 0;
    xSemaphoreTake(bufMutex, portMAX_DELAY);
    n = min(bufCount, MAX_BATCH);
    for (int i = 0; i < n; i++) batch[i] = buffer[(bufHead + i) % BUFFER_SIZE];
    xSemaphoreGive(bufMutex);
    if (n == 0) continue;

    // susun JSON array
    String json = "[";
    char ts[32];
    char line[220];
    for (int i = 0; i < n; i++) {
      formatIso(batch[i].epochMs, ts, sizeof(ts));
      if (batch[i].valid) {
        float level = H_PASANG - batch[i].distance;
        if (level < 0) level = 0;
        snprintf(line, sizeof(line),
                 "{\"created_at\":\"%s\",\"distance_cm\":%.2f,\"water_level_cm\":%.2f,"
                 "\"water_sensor_value\":%d,\"water_limit_reached\":%s}",
                 ts, batch[i].distance, level, batch[i].waterValue,
                 batch[i].limitReached ? "true" : "false");
      } else {
        // sensor gagal membaca: kirim null supaya backend tahu ada celah/gangguan
        snprintf(line, sizeof(line),
                 "{\"created_at\":\"%s\",\"distance_cm\":null,\"water_level_cm\":null,"
                 "\"water_sensor_value\":%d,\"water_limit_reached\":%s}",
                 ts, batch[i].waterValue, batch[i].limitReached ? "true" : "false");
      }
      if (i > 0) json += ",";
      json += line;
    }
    json += "]";

    http.begin(client, url);
    http.setReuse(true);
    http.setTimeout(8000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", SUPABASE_KEY);
    http.addHeader("Prefer", "return=minimal");
    int code = http.POST(json);

    bool remove = false;
    if (code >= 200 && code < 300) {
      remove = true;
    } else if (code == 400) {
      // data ditolak (format/kolom salah): mengulang tidak akan membantu, buang batch ini
      Serial.printf("[upload] 400 ditolak: %s\n", http.getString().c_str());
      remove = true;
    } else {
      Serial.printf("[upload] gagal (kode %d), %d sampel ditahan\n", code, n);
    }
    http.end();

    if (remove) {
      uint32_t lastSeq = batch[n - 1].seq;
      xSemaphoreTake(bufMutex, portMAX_DELAY);
      while (bufCount > 0 && buffer[bufHead].seq <= lastSeq) {
        bufHead = (bufHead + 1) % BUFFER_SIZE;
        bufCount--;
      }
      more = (bufCount > 0);   // masih ada antrean: kirim lagi tanpa menunggu
      xSemaphoreGive(bufMutex);
      if (code >= 200 && code < 300) Serial.printf("[upload] OK %d sampel\n", n);
    }
  }
}

// ------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(WATER_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  Serial.println();
  Serial.println("=== WATER LEVEL MONITORING (AJ-SR04M) ===");
  Serial.printf("H_PASANG = %.1f cm (wadah %.1f + sensor ke bibir %.1f)\n",
                H_PASANG, TINGGI_WADAH, JARAK_SENSOR_KE_BIBIR);

  bufMutex = xSemaphoreCreateMutex();

  // WiFi
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Menghubungkan ke WiFi");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++tries > 120) { Serial.println("\nWiFi gagal, restart"); ESP.restart(); }
  }
  Serial.println();
  Serial.print("WiFi terhubung, IP: ");
  Serial.println(WiFi.localIP());

  // NTP (UTC). Sampling baru dimulai setelah jam sinkron agar cap waktu benar.
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.print("Sinkron waktu");
  tries = 0;
  while (time(nullptr) < 1700000000) {
    delay(500);
    Serial.print(".");
    if (++tries > 60) { Serial.println("\nNTP gagal, restart"); ESP.restart(); }
  }
  Serial.println(" OK");

  xTaskCreatePinnedToCore(uploadTask, "upload", 10240, NULL, 1, NULL, 0);
  nextSampleMs = millis();
}

void loop() {
  uint32_t now = millis();
  if ((int32_t)(now - nextSampleMs) < 0) {
    delay(2);
    return;
  }
  nextSampleMs += SAMPLE_INTERVAL_MS;
  if ((int32_t)(now - nextSampleMs) >= 0) {      // tertinggal terlalu jauh: sinkron ulang
    nextSampleMs = now + SAMPLE_INTERVAL_MS;
  }

  // cap waktu diambil di awal sampel
  struct timeval tv;
  gettimeofday(&tv, NULL);

  Sample s;
  s.epochMs = (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
  float d = readDistanceMedian();
  s.valid = !isnan(d);
  s.distance = s.valid ? d : 0;
  s.waterValue = analogRead(WATER_PIN);
  s.limitReached = s.waterValue >= BATAS_WATER;
  s.seq = nextSeq++;
  pushSample(s);

  if (s.valid) {
    float level = H_PASANG - d;
    if (level < 0) level = 0;
    Serial.printf("jarak %.1f cm | tinggi air %.1f cm | antrean %d\n", d, level, bufCount);
  } else {
    Serial.printf("sensor gagal membaca (di luar jangkauan atau terlalu banyak noise) | antrean %d\n", bufCount);
  }
}
