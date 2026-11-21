import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";
import sqlite3 from "sqlite3";

const ROOT = join(import.meta.dirname, "..");
const PORT = 18890; // beda dari 1880 agar tidak bentrok dengan Node-RED yang sedang dipakai
const BASE = `http://localhost:${PORT}`;
const KEY = "iot-2410020079";
const BROKER = process.env.BROKER ?? "mqtt://localhost:1883";

let nodeRed;
let dataDir;
let client;
let ws;
const wsMessages = [];
const mqttMessages = [];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await check();
    if (found) return found;
    await delay(50);
  }
  throw new Error(`Timeout menunggu ${label}`);
}

function api(path, { method = "GET", key = KEY, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  return fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function kirimSensor(suhu, kelembaban = 60) {
  const timestamp = new Date().toISOString();
  client.publish("iot/sensor", JSON.stringify({ suhu, kelembaban, timestamp }));
  return waitFor(
    () => wsMessages.find(m => m.type === "sensor" && m.data.timestamp === timestamp),
    `data sensor ${suhu} lewat WebSocket`
  );
}

// Data dari simulator yang masih jalan akan mengacaukan jumlah history dan notifikasi
async function pastikanTidakAdaPublisherLain() {
  const pengintai = await mqtt.connectAsync(BROKER);
  let ada = false;
  pengintai.on("message", () => { ada = true; });
  await pengintai.subscribeAsync("iot/sensor");
  await delay(3500); // simulator publish setiap 3 detik
  await pengintai.endAsync();
  if (ada) throw new Error("Ada data lain di topik iot/sensor. Matikan simulasi_esp32.py dulu sebelum npm test.");
}

before(async () => {
  await pastikanTidakAdaPublisherLain();
  dataDir = mkdtempSync(join(tmpdir(), "piot-test-"));
  // cwd di folder sementara supaya iot.db hasil test tidak bercampur dengan data asli
  nodeRed = spawn(process.execPath, [join(ROOT, "node_modules/node-red/red.js"), "-u", join(ROOT, "nodered"), "-p", String(PORT)], { cwd: dataDir });
  let output = "";
  nodeRed.stdout.on("data", chunk => { output += chunk; });
  nodeRed.stderr.on("data", chunk => { output += chunk; });
  await waitFor(() => output.includes("subscribe iot/sensor") && output.includes("Connected to broker"), "Node-RED siap menerima data sensor", 30000)
    .catch(err => { throw new Error(`${err.message}\n${output}`); });

  client = await mqtt.connectAsync(BROKER);
  await client.subscribeAsync(["iot/kontrol", "iot/notifikasi"]);
  client.on("message", (topic, payload) => mqttMessages.push({ topic, data: JSON.parse(payload) }));

  ws = new WebSocket(`ws://localhost:${PORT}/ws/sensor`);
  ws.onmessage = event => wsMessages.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
});

after(async () => {
  ws?.close();
  await client?.endAsync();
  nodeRed?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("dashboard", () => {
  test("disajikan Node-RED di /dashboard/", async () => {
    const res = await fetch(`${BASE}/dashboard/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Monitoring Suhu/);
  });
});

describe("autentikasi X-API-Key", () => {
  const endpoints = [
    ["GET", "/suhu"], ["GET", "/history"], ["POST", "/kontrol"], ["GET", "/threshold"], ["PUT", "/threshold"]
  ];

  for (const [method, path] of endpoints) {
    test(`${method} /api${path} tanpa key ditolak 401`, async () => {
      const res = await api(path, { method, key: null, body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).status, "error");
    });
  }

  test("key yang salah ditolak 401", async () => {
    const res = await api("/suhu", { key: "salah" });
    assert.equal(res.status, 401);
  });

  test("preflight CORS mengizinkan header X-API-Key dan method PUT", async () => {
    const res = await fetch(`${BASE}/api/threshold`, {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "x-api-key,content-type" }
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers"), /X-API-Key/i);
    assert.match(res.headers.get("access-control-allow-methods"), /PUT/);
  });
});

describe("data sensor", () => {
  test("data MQTT diteruskan ke WebSocket dan GET /api/suhu", async () => {
    await kirimSensor(25.5, 61.2);
    const res = await api("/suhu");
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, "success");
    assert.equal(json.data.suhu, 25.5);
    assert.equal(json.data.kelembaban, 61.2);
    assert.ok(json.data.received);
  });

  test("data yang bukan angka diabaikan", async () => {
    client.publish("iot/sensor", JSON.stringify({ suhu: "panas", kelembaban: 60 }));
    await delay(500);
    const json = await (await api("/suhu")).json();
    assert.equal(json.data.suhu, 25.5);
  });

  test("history tersimpan di SQLite, urut dari lama ke baru", async () => {
    for (const suhu of [24.1, 24.2, 24.3]) await kirimSensor(suhu);

    // WebSocket bisa sampai lebih dulu daripada INSERT ke SQLite selesai
    const semua = await waitFor(async () => {
      const json = await (await api("/history")).json();
      return json.count === 4 && json;
    }, "4 baris history");
    assert.deepEqual(semua.data.map(d => d.suhu), [25.5, 24.1, 24.2, 24.3]);

    const dua = await (await api("/history?limit=2")).json();
    assert.deepEqual(dua.data.map(d => d.suhu), [24.2, 24.3]);

    const db = new sqlite3.Database(join(dataDir, "iot.db"), sqlite3.OPEN_READONLY);
    const row = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS n FROM sensor", (err, r) => err ? reject(err) : resolve(r)));
    db.close();
    assert.equal(row.n, 4);
  });
});

describe("kontrol perangkat", () => {
  test("body tanpa action ditolak 400", async () => {
    const res = await api("/kontrol", { method: "POST", body: { device: "lamp" } });
    assert.equal(res.status, 400);
  });

  test("perintah valid dipublish ke MQTT iot/kontrol", async () => {
    const res = await api("/kontrol", { method: "POST", body: { device: "lamp", action: "on" } });
    assert.equal(res.status, 200);
    const pesan = await waitFor(() => mqttMessages.find(m => m.topic === "iot/kontrol"), "perintah di iot/kontrol");
    assert.deepEqual(pesan.data, { device: "lamp", action: "on" });
  });
});

describe("threshold dan notifikasi", () => {
  test("batas default 30", async () => {
    const json = await (await api("/threshold")).json();
    assert.equal(json.batas, 30);
  });

  test("batas yang bukan angka atau di luar rentang ditolak 400", async () => {
    for (const batas of ["abc", 100, null]) {
      const res = await api("/threshold", { method: "PUT", body: { batas } });
      assert.equal(res.status, 400, `batas ${batas}`);
    }
  });

  test("PUT menyimpan batas dan menyiarkannya lewat WebSocket", async () => {
    const res = await api("/threshold", { method: "PUT", body: { batas: 26 } });
    assert.equal(res.status, 200);
    await waitFor(() => wsMessages.find(m => m.type === "threshold" && m.batas === 26), "perubahan batas lewat WebSocket");
    const json = await (await api("/threshold")).json();
    assert.equal(json.batas, 26);
  });

  test("suhu melewati batas mengirim notifikasi ke MQTT dan WebSocket", async () => {
    await kirimSensor(27);
    const alert = await waitFor(() => wsMessages.find(m => m.type === "alert"), "notifikasi lewat WebSocket");
    assert.equal(alert.suhu, 27);
    assert.equal(alert.batas, 26);
    const notif = await waitFor(() => mqttMessages.find(m => m.topic === "iot/notifikasi"), "notifikasi di iot/notifikasi");
    assert.equal(notif.data.suhu, 27);
  });

  test("notifikasi tidak berulang selama suhu masih di atas batas", async () => {
    await kirimSensor(28);
    await delay(300);
    assert.equal(wsMessages.filter(m => m.type === "alert").length, 1);
  });

  test("notifikasi muncul lagi setelah suhu turun lalu naik lagi", async () => {
    await kirimSensor(25);
    await kirimSensor(27.5);
    await waitFor(() => wsMessages.filter(m => m.type === "alert").length === 2, "notifikasi kedua");
  });
});
