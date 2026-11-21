import json
import os
import random
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER = os.environ.get("BROKER", "localhost")
TOPIC_SENSOR = "iot/sensor"
TOPIC_KONTROL = "iot/kontrol"
TOPIC_NOTIFIKASI = "iot/notifikasi"

lampu = "off"


def on_connect(client, userdata, flags, reason_code, properties):
    print(f"Terhubung ke broker {BROKER} ({reason_code})")
    client.subscribe([(TOPIC_KONTROL, 0), (TOPIC_NOTIFIKASI, 1)])


def on_message(client, userdata, msg):
    global lampu
    data = json.loads(msg.payload)
    if msg.topic == TOPIC_KONTROL and data.get("device") == "lamp":
        lampu = data.get("action")
        print(f"<- Kontrol: LED {lampu.upper()}")
    elif msg.topic == TOPIC_NOTIFIKASI:
        print(f"<- NOTIFIKASI: {data['pesan']}")


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ESP32-Simulator")
client.on_connect = on_connect
client.on_message = on_message
client.connect(BROKER, 1883, 60)
client.loop_start()

print("ESP32 Simulator berjalan... Ctrl+C untuk stop")

# Random walk supaya grafik terlihat seperti sensor sungguhan, bukan acak melompat
suhu = 28.0
kelembaban = 65.0
try:
    while True:
        suhu = min(max(suhu + random.uniform(-0.8, 0.8), 24), 34)
        kelembaban = min(max(kelembaban + random.uniform(-2, 2), 50), 85)
        data = {
            "suhu": round(suhu, 1),
            "kelembaban": round(kelembaban, 1),
            "timestamp": datetime.now().isoformat(timespec="seconds"),
        }
        client.publish(TOPIC_SENSOR, json.dumps(data))
        print(f"-> Publish: {data}")
        time.sleep(3)
except KeyboardInterrupt:
    client.loop_stop()
    client.disconnect()
