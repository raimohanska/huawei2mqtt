# Session handoff — 2026-10-21

## Objective and scope

Build a small service on an existing Raspberry Pi to read the inverter's AC
active power and publish it to MQTT on the home LAN. A direct Modbus-to-MQTT
collector is the likely next step; a transparent TCP relay was discussed but
is not required for this objective.

This work began in the unrelated `../raimo_esphome` repository. The user explicitly
requested a separate project here and said **not to commit**. A temporary tester
commit was undone in that repository. No relay or MQTT implementation was written.
This folder was created as a handoff, without initializing Git or making commits.
The original tester and reports remain in the old directory; these are copies.

## Confirmed inverter connection

| Item | Value |
| --- | --- |
| Inverter | Huawei SUN2000-8KTL-M1 |
| Firmware | Unknown; not obtained yet |
| Installer access | User does not have it |
| Working network | Inverter's own SUN2000 Wi-Fi hotspot |
| Inverter address | `192.168.200.1` |
| TCP port | `6607` |
| Modbus unit/slave ID | **`0`** |
| Protocol | Plain Modbus TCP, holding-register reads (function `03`) |
| Authentication | No installer login needed for confirmed reads |

**FusionSolar/device commissioning must be closed.** Initial tests accepted TCP
but closed immediately on Modbus requests while FusionSolar was open. After
closing it, reads succeeded. Avoid competing local clients. Do not run the tester
and future collector simultaneously.

The inverter hotspot's credentials are known to the user and configured on the
Pi. Do not ask them to paste passwords or include credentials in source control.

## Confirmed registers

Use literal Huawei register addresses; do not subtract one or add a 40000 offset.

| Reading | Start | Count | Decode | Observed |
| --- | --- | --- | --- | --- |
| Model | `30000` | 15 | ASCII, null padded/separated | SUN2000-8KTL-M1 plus additional identification text |
| AC active power | **`32080`** | **2** | **Big-endian signed int32, watts, scale 1** | **0 W**, raw `00000000` |
| Daily yield | `32119` | 2 | Intended unsigned int32 / 100 kWh | Exception `0x02`, illegal register address |

Power decoding is implemented in the tester. It treats `0x7fffffff` as the signed
unavailable sentinel. A zero-watt read is a valid response, not a connection failure.
Only zero power was observed; verify a nonzero value during generation in future.
The model decoder currently includes text after an embedded null; splitting at
the first null would improve presentation but is not needed for power collection.

## Pi setup and current network state

- OS: **Raspbian GNU/Linux 9 (stretch)**.
- Python 3 is installed and has successfully run the tester. Exact version unknown;
  Stretch normally supplies Python 3.5, so verify before choosing dependencies or
  using newer syntax. The existing tester uses standard-library, Python-3.5-compatible code.
- SSH username not recorded; user has sudo access.
- Ethernet: `eth0`, DHCP address **`192.168.1.14/24`**.
- Wi-Fi: `wlan0`, associated to the inverter hotspot with WPA2-PSK/CCMP;
  static address **`192.168.200.2/24`**, no gateway.
- LAN default gateway: **`192.168.1.1`**, via Ethernet.
- Network management: **ifupdown**, `/etc/network/interfaces`, `networking.service`.
- `dhcpcd.service` is enabled but fails because interfaces are defined through
  ifupdown. It is not the active interface manager. NetworkManager and
  systemd-networkd are not active.
- A global `wpa_supplicant` service runs with `-u -s -O /run/wpa_supplicant`;
  ifupdown starts the interface-specific supplicant.
- `socat` was not found by `command -v`; no new packages have been installed.

The user was instructed to make `/etc/network/interfaces` equivalent to:

```text
auto lo
iface lo inet loopback

source-directory /etc/network/interfaces.d

auto eth0
iface eth0 inet dhcp

auto wlan0
allow-hotplug wlan0
iface wlan0 inet static
    address 192.168.200.2
    netmask 255.255.255.0
    wpa-ssid "SUN2000-<actual hotspot suffix>"
    wpa-psk "<configured locally; do not copy into project>"
```

Backup on Pi: `/etc/network/interfaces.before-sun2000`. The user was instructed
to restrict the live interfaces file to mode 600. The exact final file was not
read back, but association, addressing, routing, and Modbus were confirmed.

During transition the old home-Wi-Fi address `192.168.1.233/24` remained alongside
the new static address. The user was instructed to remove it:

```sh
sudo ip address del 192.168.1.233/24 dev wlan0
```

Last confirmed route checks:

```text
192.168.200.1 dev wlan0 src 192.168.200.2
1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.14
```

Ethernet's default route was also set manually during setup:

```sh
sudo ip route replace default via 192.168.1.1 dev eth0
```

Persistence across reboot has **not** been tested. Verify association and both
routes after reboot before declaring setup complete. Keep a working Ethernet
SSH session during changes. Consider a DHCP reservation for the Pi Ethernet IP.

### Resolved startup race

The first `ifdown wlan0` / `ifup wlan0` attempt failed because a new supplicant
started before the old one released `/run/wpa_supplicant/wlan0`. Retrying after
the old process exited worked. The log also showed an address-removal error
because the config had already changed from DHCP to static.

Do not indiscriminately kill the global supplicant. Only remove a stale wlan0
socket after confirming no interface-specific process owns it and `wpa_cli`
cannot connect.

## Last successful test, run on the Pi

```sh
python3 ~/huawei_modbus_test.py --port 6607 --unit 0 --timeout 15 --delay 2
```

User pasted this result after networking was configured:

```text
TCP connection accepted.
Model [30000]: SUN2000-8KTL-M1 (plus additional identification text)
AC active power [32080]: 0 W (raw 00000000)
Daily yield [32119]: Modbus exception 0x02: illegal register address
PASS: Read 2 register range(s) without an installer login.
Working settings: host=192.168.200.1 port=6607 unit=0
```

The copied `huawei-modbus-report.txt` is the earlier successful computer test;
the Pi's successful result above was pasted into the conversation, not saved
as a separate report file.

## Dongle LAN path did not work

Dongle IP on another LAN subnet: `192.168.2.70`; dongle model and firmware unknown.
With FusionSolar closed, read-only testing found:

- `502/tcp`: connection refused, both unit IDs 1 and 0.
- `6607/tcp`: connection refused, both unit IDs 1 and 0.
- `6606/tcp`: accepts TCP, then closes Modbus requests for both IDs; protocol unknown.
- A broad TCP scan found only 6606 open, but many probes timed out.
- No useful web, SSH, Telnet, or MQTT service was found at the common tested ports.

Dongle Modbus is likely disabled/unavailable on the LAN; this was not proven by
inspecting settings. User cannot enable it through installer access. Use the
confirmed inverter-hotspot route instead of repeating LAN scans.

A TLS handshake against hotspot port 6607 also failed (reset, zero bytes read,
no certificate/cipher). Misleading OpenSSL `TLSv1.3` / `Verification: OK` output
did not represent successful negotiation. Plain Modbus was subsequently proven.

## Suggested next session

1. Work in **this directory**, not `raimo_esphome`. Do not commit unless requested.
2. Obtain the MQTT broker host/port, authentication/TLS requirements, desired
   topic format, and desired polling interval from the user. None are known yet.
   Do not read the old repo's `secrets.yaml` to discover these values.
3. Check the Pi's exact Python version and existing MQTT libraries. Prefer a
   small maintainable implementation compatible with the actual runtime; if a
   dependency is needed, account for old Python compatibility.
4. Implement a direct Modbus-to-MQTT collector: read holding registers 32080–32081,
   unit 0, decode signed watts, and publish the measurement. Reuse the tester's
   framing/validation logic as appropriate. Never publish fabricated zero power
   on a timeout or invalid/unavailable reading.
5. Add reconnect/backoff for Wi-Fi/inverter and MQTT interruptions; choose a
   modest configurable polling interval (e.g. 10–30 seconds as an initial proposal).
   Avoid repeated model reads once identification is established.
6. Use external configuration for credentials. Decide MQTT availability/LWT,
   timestamps, retention/stale-value behavior, and optionally Home Assistant
   discovery with the user. These details are not yet agreed.
7. Provide a systemd service to start at boot and recover after failures. A
   separate LAN TCP relay is optional; none exists yet. No NAT/IP forwarding is
   needed if the Pi itself reads Modbus and publishes MQTT over Ethernet.
8. Verify MQTT delivery end to end, nonzero generation when possible, reconnection,
   and reboot persistence of Wi-Fi, routes, and the collector service.

An earlier proposed relay endpoint was `192.168.1.14:1502` forwarding to
`192.168.200.1:6607`, retaining unit ID 0. This was just a proposal, not deployed.

## Verification already performed on the tester

On the development computer: CLI help, whitespace checks, and an in-memory
simulated Modbus server exercised fragmented TCP replies, fallback from unit 0
to 1, negative signed power, energy scaling, Modbus exceptions, malformed replies,
peer closure, and timeouts. These test harnesses were temporary inline commands,
not saved as a test suite. Real model and AC-power reads succeeded from both
the computer and the Pi. No MQTT behavior has been tested.

Reference: https://github.com/wlcrs/huawei_solar/wiki/Connecting-to-the-inverter
