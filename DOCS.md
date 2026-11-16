# Huawei to MQTT — Home Assistant app

Unofficial app; not affiliated with, sponsored by, or endorsed by Huawei.
Huawei and product names are trademarks of their respective owners and are
used only to identify compatible products. Project code is licensed under the
[MIT License](LICENSE); third-party software and trademarks are not covered.

Runs `huawei-read.js` continuously: read-only Modbus polling, MQTT publishing,
and automatic Home Assistant sensor discovery. No FusionSolar login, browser,
report exports, or InfluxDB are involved.

## Install locally on Home Assistant OS

1. Create `/addons/huawei2mqtt/` on the Home Assistant host (for example through
   the Samba or SSH app).
2. Copy these files from this repository into that directory:
   `config.json`, `Dockerfile`, `.dockerignore`, `huawei-read.js`, `ha-run.js`,
   `README.md`, `DOCS.md`, and `LICENSE`. Include the hidden `.dockerignore` file.
   **Do not copy any `.env` files or the `report_exporter/` directory.**
3. In **Settings → Apps → Install app** (formerly **Add-on store**), use the
   menu to check for updates/reload. Find **Huawei to MQTT** under **Local apps**
   and install it. The image builds locally; internet access is needed to pull
   the Node base image. Supported hosts: aarch64 and amd64.
4. Open its **Configuration** page, enter the settings below, and save.
5. Stop other bridge instances and Modbus clients, including FusionSolar device
   commissioning, before starting this app. Enable **Start on boot** if desired.
6. Configure Home Assistant's **MQTT integration** for the same broker. Sensors
   appear under **Settings → Devices & services → MQTT → Huawei Inverter**.

## Configuration

| Setting | Meaning / default |
| --- | --- |
| `MODBUS_HOST` | Inverter address reachable from the HA host; default `192.168.200.1` |
| `MODBUS_PORT` | Inverter TCP port; default `6607` |
| `MODBUS_UNIT` | Modbus unit ID; default `0` |
| `MODBUS_TIMEOUT` | Connection/read timeout in seconds; default `15` |
| `MODBUS_DELAY` | Delay between requests in seconds; default `2` |
| `MQTT_BROKER_URL` | `mqtt://hostname:port`; default `mqtt://core-mosquitto:1883` for the Mosquitto app |
| `MQTT_USER` | Required MQTT account username |
| `MQTT_PASSWORD` | Required MQTT password; masked in the configuration form |
| `MQTT_TOPIC_PREFIX` | Telemetry topic prefix; default `huawei` |
| `HA_DISCOVERY_PREFIX` | HA MQTT discovery prefix; default `homeassistant` |
| `HA_DEVICE_NAME` | Name displayed in Home Assistant; default `Huawei Inverter` |
| `POLL_INTERVAL` | Seconds between polling-cycle starts, 5–86400; default `15` |

Use your inverter's actual connection settings; hotspot and LAN addresses/ports
can differ. The HA host must have a route to the inverter. No inbound ports or
host networking are required. MQTT currently supports plain TCP only; use a
trusted network. Credentials must be separate from the broker URL.

The app reads `/data/options.json`, not `.env` or inherited configuration
variables. Credentials are not printed, but are stored in HA app settings and
may be included in HA backups: protect those backups. Restart after changes.

## Operation

The **Log** tab shows connections, telemetry, and automatic recovery with a
2–60 second retry backoff. Stop/Restart sends the reader its shutdown signal;
the MQTT Last Will marks the device offline. Only one instance should run per
inverter. Keep topic prefixes stable to retain entity identities.

Read failures mark sensors unavailable rather than inventing zero readings.
Slower polling cycles never overlap. The total-yield sensor can be used for
solar production in the Energy dashboard. See the repository README for entity
and topic details.

## Offline developer checks

```sh
node --test ha-run.test.js
```

These tests do not load credentials, connect to an inverter, or publish MQTT.
