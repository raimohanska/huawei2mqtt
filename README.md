# huawei2mqtt

Unofficial project; not affiliated with, sponsored by, or endorsed by Huawei.
Huawei and product names are trademarks of their respective owners and are
used only to identify compatible products.

Licensed under the [MIT License](LICENSE). This licence covers this project's
code, not third-party software or trademarks.

Goal: read AC active power from a Huawei SUN2000-8KTL-M1 inverter on a Raspberry
Pi and publish it to an MQTT broker on the home network.

**Read-only Modbus access from the Pi is confirmed working.** The single-file
Node 12 reader supports one-shot snapshots and continuous MQTT publishing with
Home Assistant discovery. See [HANDOFF.md](HANDOFF.md) for earlier connection history.

## MQTT bridge and Home Assistant discovery

### Home Assistant app

To run the bridge inside Home Assistant OS, see [app installation and
configuration](DOCS.md). All Modbus and MQTT settings are entered on the app's
**Configuration** page; no `.env` file is needed. The app runs `huawei-read.js`,
not the FusionSolar report exporter.

Add `https://github.com/raimohanska/huawei2mqtt` under the app store's
**Repositories** menu to install directly from GitHub.

### Standalone Raspberry Pi

Copy the updated `huawei-read.js` to the Pi using the command below. Add the
following settings to your existing `.env` **locally on the Pi**; keep your
existing `MODBUS_*` settings:

```dotenv
MQTT_BROKER_URL=mqtt://your-broker-hostname-or-ip:1883
MQTT_USER=your-username
MQTT_PASSWORD="your-password"
MQTT_TOPIC_PREFIX=huawei
HA_DISCOVERY_PREFIX=homeassistant
HA_DEVICE_NAME="Huawei Inverter"
POLL_INTERVAL=15
```

Then run (with FusionSolar and the one-shot reader stopped):

```sh
node ~/huawei-read.js
```

No npm packages are required. This mode uses MQTT 3.1.1 over plain TCP with
username/password authentication. The broker URL must use `mqtt://`; its port
defaults to 1883 if omitted. Credentials go in `MQTT_USER` and `MQTT_PASSWORD`,
not in the URL. It reconnects with a 2–60 second backoff after
connection/read failures. Ctrl+C stops it and triggers the offline Last Will.
Automatic startup through systemd is not configured yet.

Operational logs go to stderr with local ISO datetime prefixes (including the
UTC offset, using the host's configured timezone) and `INFO`, `WARN`,
or `ERROR` levels. They cover connection/reconnection, discovery acknowledgement,
published power, full telemetry summaries and cycle duration, read failures,
fallback reads, retry delays, and shutdown. Credentials are not logged. Example:

```text
2026-10-21T23:15:00.123+03:00 [INFO] Reading full telemetry.
```

MQTT mode emits human-readable logs rather than raw telemetry JSON. One-shot
mode keeps its JSON document on stdout and timestamped progress on stderr.

In Home Assistant, configure the **MQTT integration** to use the same broker.
With MQTT discovery enabled, look under **Settings → Devices & services → MQTT →
Devices** for **Huawei Inverter**. Discovery messages are retained and republished
on broker reconnection. All entities share one device identifier based on the
inverter's serial number, with manufacturer/model/serial metadata. Keep the
discovery prefix and serial identity stable to preserve entity IDs. Only one
bridge instance should run per inverter; the default topic prefix assumes one
inverter. Give each bridge its own prefix if adding another inverter.

Entities:

| Entity | Unit | HA metadata |
| --- | --- | --- |
| Active power | W | Power, measurement |
| Daily yield | kWh | Energy, total increasing (daily reset) |
| Total yield | kWh | Energy, total increasing |
| Peak active power today | W | Power, measurement |
| Input power | kW | Power, measurement |
| PV1 / PV2 voltage | V | Voltage, measurement |
| PV1 / PV2 current | A | Current, measurement |
| Internal temperature | °C | Temperature, measurement |
| Device status | text | Operating state; unknown codes preserved as `unknown_CODE` |
| Device status code | numeric | Diagnostic entity |

The total-yield sensor is suitable as a solar production source in HA's Energy
dashboard. HA may need a few updates to make statistics available.

### MQTT reading IDs

The following IDs are the JSON field names in `huawei/telemetry` and the field
suffixes used in Home Assistant discovery. Topics below assume the default
`MQTT_TOPIC_PREFIX=huawei` and `HA_DISCOVERY_PREFIX=homeassistant`.

| Reading | Field ID | Unit |
| --- | --- | --- |
| Active power | `active_power_w` | W |
| Daily yield | `daily_yield_kwh` | kWh |
| Total yield | `total_yield_kwh` | kWh |
| Peak active power today | `peak_active_power_today_w` | W |
| Input power | `input_power_kw` | kW |
| PV1 voltage | `pv1_voltage_v` | V |
| PV1 current | `pv1_current_a` | A |
| PV2 voltage | `pv2_voltage_v` | V |
| PV2 current | `pv2_current_a` | A |
| Internal temperature | `internal_temperature_c` | °C |
| Device status | `device_status` | text |
| Device status code | `device_status_code` | numeric |

For each field:

- **Home Assistant unique ID:** `huawei_<normalized_serial>_<field_id>`.
- **Discovery topic:**
  `homeassistant/sensor/huawei_<normalized_serial>/<field_id>/config`.
- **State topic:** `huawei/telemetry`, using the JSON field above. Active power
  instead uses the numeric payload on `huawei/active_power` for its HA entity;
  it is also included as `active_power_w` in the telemetry JSON.

`<normalized_serial>` is the inverter serial number converted to lowercase,
with characters outside `a-z`, `0-9`, `_`, and `-` replaced by `_`. For example,
a serial of `ABC123` gives the daily-yield unique ID
`huawei_abc123_daily_yield_kwh` and discovery topic
`homeassistant/sensor/huawei_abc123/daily_yield_kwh/config`.

Home Assistant's `sensor.…` entity IDs are assigned by HA and can be renamed;
the exact entity IDs can be found on the MQTT device's entity pages.
The telemetry JSON also contains `timestamp`, a UTC timestamp for the sample,
which is not exposed as a separate discovery entity.

MQTT topics (default prefix):

- `huawei/active_power`: numeric watts, non-retained, QoS 1; scheduled every 15s.
- `huawei/telemetry`: timestamped JSON, non-retained, QoS 1; scheduled every 15s.
- `huawei/status`: retained `online`/`offline`, QoS 1, with offline Last Will.
- `homeassistant/sensor/huawei_<serial>/<field>/config`: retained discovery.

The bridge reads identity once at startup and uses grouped telemetry reads to
reduce inverter traffic. If firmware rejects a grouped range, it falls back to
individual reads. `POLL_INTERVAL` sets the time between full cycle starts
(default 15 seconds, integer range 5–86400). `MODBUS_DELAY` is separate: it spaces
requests within each cycle (default 2 seconds). Requests remain sequential;
slower responses or fallback reads can extend a cycle beyond `POLL_INTERVAL`.
The bridge then logs a warning and starts the next cycle after completion,
without overlapping requests. Power and all other selected fields are published
in every cycle. The former `POWER_INTERVAL` and `TELEMETRY_INTERVAL` settings are
replaced by `POLL_INTERVAL`.

Availability is set online only after a successful full telemetry publication.
Read errors mark the device offline rather than publishing fabricated zeros.
Each sensor also expires after three configured update periods without its own
updates, covering a frozen bridge. Null telemetry fields are individually marked
unavailable. On HA restart, retained discovery recreates the configuration; fresh
sensor states arrive at the next poll because measurements are not retained.
The broker detects a lost connection within its MQTT keepalive window (30s
keepalive, typically up to 45s for a silent network loss).

The observed status `40960` (`0xA000`) is standby/no irradiation. On this firmware,
zero temperature in that state is exported as null/unavailable. Other real zero
readings, including nighttime active power, are preserved.

## One-shot JavaScript reader

`huawei-read.js` runs on **Node 12.13.1**, using only built-in modules. No npm
install or Python packages are needed. Connection settings are loaded from an
optional `.env` file beside the script. No Modbus credentials are required.

Copy it from this computer, replacing the SSH username:

```sh
scp huawei-read.js .env.example <pi-username>@192.168.1.14:~/
```

On the Pi, create the configuration once (skip the copy if you already have a
`.env` there), then edit it locally:

```sh
cp -n ~/.env.example ~/.env
chmod 600 ~/.env
nano ~/.env
```

The template is prefilled with the confirmed inverter settings:

```dotenv
MODBUS_HOST=192.168.200.1
MODBUS_PORT=6607
MODBUS_UNIT=0
MODBUS_TIMEOUT=15
MODBUS_DELAY=2
```

The `.env` belongs beside `huawei-read.js`, regardless of the shell's current
directory. Precedence is command-line flags, then process environment variables,
then `.env`, then built-in defaults (the same values as the template). Blank
settings are rejected. The parser supports `KEY=value`, optional `export`,
comments, and single/double-quoted literal values; it does not expand variables
or backslash escapes. MQTT settings are ignored in one-shot mode. Keep your real
`.env` on the Pi; it is excluded by `.gitignore`.

**Close FusionSolar/device commissioning and stop any other Modbus client**,
then run:

```sh
node ~/huawei-read.js --once
```

It prints progress to stderr immediately, then one JSON document to stdout and
exits. Allow about one minute for the
27 individual read-only probes, with the default two-second spacing. Each reading
includes its literal register address, unit, raw hex, and decoded value. A real
zero is preserved; unsupported registers and unavailable sentinel values have
`value: null` and an `error`. Modbus exceptions do not prevent subsequent probes.
A connection, timeout, or framing failure ends the snapshot with a top-level
`error` and exit status 1; previously collected readings are preserved. Exit
status is also 1 if no usable readings were returned.

Optional overrides (times in seconds):

```sh
node ~/huawei-read.js --once --host 192.168.200.1 --port 6607 --unit 0 --timeout 15 --delay 2
```

Candidate readings include model/serial, PV1/PV2 voltage and current, DC input
power, line/phase voltages and currents, AC active/reactive power, today's peak
power, power factor, grid frequency, efficiency, internal temperature, insulation
resistance, numeric device status, and total/daily energy yield. This is a list of
known Huawei telemetry addresses, **not an exhaustive register scan**. All 27
register probes succeeded on the Pi on 2026-10-21, during nighttime standby.
Nonzero production measurements still need daytime verification. Values are
sampled sequentially, not simultaneously. Other inverter models may have more PV
inputs; this script probes the two inputs expected on this SUN2000-8KTL-M1.

Daily yield is probed at **32114** in this iteration. The earlier tester used
32119 and received an illegal-address exception. Register 32114 was subsequently
confirmed working (2.99 kWh). Unknown device-status codes are left numeric in
one-shot output.

## FusionSolar browser automation (development computer)

Playwright and all report extraction code live in
[`report_exporter/`](report_exporter/README.md), separately from the
dependency-free MQTT bridge on the Pi. See that directory's README for setup
and browser commands.

## Files

- `huawei-read.js`: dependency-free Node 12 snapshot reader and MQTT/HA bridge.
- `.env.example`: Modbus, MQTT, and Home Assistant configuration template.
- `huawei_modbus_test.py`: standalone, standard-library Python Modbus TCP tester.
- `huawei-modbus-report.txt`: successful inverter hotspot test from the computer.
- `huawei-lan-report.txt`: failed dongle LAN test, with FusionSolar closed.
- `huawei-tls-report.txt`: unsuccessful TLS handshake test against the hotspot.
- `HANDOFF.md`: hardware, network configuration, results, and next steps.

## Test on the Pi

Keep FusionSolar/device commissioning closed while testing:

```sh
python3 ~/huawei_modbus_test.py --port 6607 --unit 0 --timeout 15 --delay 2
```

The tester is already present in the Pi user's home directory. For a fresh copy,
run from this folder on the development computer, replacing the username:

```sh
scp huawei_modbus_test.py <pi-username>@192.168.1.14:~/
```

No installer login or Internet connection is needed for these reads.
