#!/usr/bin/env python3
"""Offline, read-only Huawei SUN2000 Modbus TCP tester (Python standard library).

Join the SUN2000 Wi-Fi, close FusionSolar/device commissioning, then run:
    python3 huawei_modbus_test.py | tee huawei-modbus-report.txt

No Internet, packages, installer login, or configuration writes are needed.
Default target: 192.168.200.1, ports 6607 then 502, unit IDs 0 then 1.
Exit codes: 0 = register data read, 1 = no register data, 2 = invalid arguments.
"""

import argparse
import math
import socket
import struct
import sys
import time


class ProtocolError(Exception):
    pass


class ModbusException(ProtocolError):
    pass


def receive_exact(sock, length):
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise ProtocolError("Peer closed connection before a complete response")
        data.extend(chunk)
    return bytes(data)


def read_registers(sock, transaction, unit, address, count):
    # Function 03 only: read holding registers. Addresses are Huawei's literal
    # register numbers, without subtracting one or adding a 40000 offset.
    request = struct.pack(">HHHBBHH", transaction, 0, 6, unit, 3, address, count)
    sock.sendall(request)
    header = receive_exact(sock, 7)
    response_transaction, protocol, length, response_unit = struct.unpack(
        ">HHHB", header
    )
    if response_transaction != transaction or protocol != 0 or response_unit != unit:
        raise ProtocolError("Response transaction, protocol, or unit ID did not match")
    if not 2 <= length <= 254:
        raise ProtocolError("Invalid Modbus response length: {}".format(length))
    pdu = receive_exact(sock, length - 1)
    if pdu[0] == 0x83:
        if len(pdu) != 2:
            raise ProtocolError("Malformed Modbus exception response")
        names = {
            1: "illegal function",
            2: "illegal register address",
            3: "illegal data value",
            4: "device failure",
            6: "device busy",
            10: "gateway path unavailable",
            11: "gateway target did not respond",
        }
        raise ModbusException(
            "Modbus exception 0x{:02x}: {}".format(
                pdu[1], names.get(pdu[1], "vendor/unknown exception")
            )
        )
    if pdu[0] != 3 or len(pdu) != 2 + count * 2 or pdu[1] != count * 2:
        raise ProtocolError("Unexpected function, byte count, or response size")
    return pdu[2:]


def describe_error(error):
    if isinstance(error, socket.timeout):
        return "Timed out waiting for connection or response"
    return str(error)


def test_target(host, port, unit, timeout, delay):
    print("\n--- {}:{} / unit {} ---".format(host, port, unit), flush=True)
    # Model and two independent telemetry reads also allow detection of devices
    # whose firmware does not expose one of these register ranges.
    probes = [
        ("Model", 30000, 15, None, None),
        ("AC active power", 32080, 2, ">i", 1),
        ("Daily yield", 32119, 2, ">I", 100),
    ]
    successes = 0
    modbus_seen = False
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            print("TCP connection accepted.", flush=True)
            time.sleep(delay)
            for transaction, (label, address, count, fmt, scale) in enumerate(probes, 1):
                try:
                    data = read_registers(sock, transaction, unit, address, count)
                except ModbusException as error:
                    modbus_seen = True
                    print("  {} [{}]: {}".format(label, address, error), flush=True)
                except (OSError, ProtocolError) as error:
                    # After a timeout or malformed response, a late frame could
                    # be mistaken for the next request's response. Stop here.
                    print("  {} [{}]: {}".format(label, address, describe_error(error)),
                          flush=True)
                    break
                else:
                    modbus_seen = True
                    successes += 1
                    if fmt is None:
                        value = repr(data.rstrip(b"\x00 ").decode("ascii", errors="replace"))
                    else:
                        raw = struct.unpack(fmt, data)[0]
                        invalid = (0x7FFFFFFF if fmt == ">i" else 0xFFFFFFFF)
                        if raw == invalid:
                            value = "unavailable (device sentinel value)"
                        elif label == "AC active power":
                            value = "{} W".format(raw)
                        else:
                            value = "{:.2f} kWh".format(raw / scale)
                    print("  {} [{}]: {} (raw {})".format(label, address, value, data.hex()),
                          flush=True)
                time.sleep(delay)
    except OSError as error:
        print("  Connection failed: {}".format(describe_error(error)), flush=True)
    return successes, modbus_seen


def bounded_integer(low, high):
    def parse(value):
        try:
            number = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError("Expected an integer")
        if not low <= number <= high:
            raise argparse.ArgumentTypeError("Expected {} through {}".format(low, high))
        return number
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="192.168.200.1")
    parser.add_argument("--port", type=bounded_integer(1, 65535), nargs="+",
                        default=[6607, 502], help="Ports to try (default: 6607 502)")
    parser.add_argument("--unit", type=bounded_integer(0, 247), nargs="+",
                        default=[0, 1], help="Unit IDs to try (default: 0 1)")
    parser.add_argument("--timeout", type=float, default=8,
                        help="Socket timeout in seconds (default: 8)")
    parser.add_argument("--delay", type=float, default=1,
                        help="Pause after connection and between reads (default: 1)")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    if not math.isfinite(args.delay) or args.delay < 0:
        parser.error("--delay must be finite and nonnegative")

    print("Huawei SUN2000 offline Modbus tester - READ ONLY", flush=True)
    print("Close FusionSolar commissioning before testing (it may take the connection).",
          flush=True)
    print("Target: {}; ports: {}; units: {}".format(args.host, args.port, args.unit),
          flush=True)
    modbus_seen = False
    for port in args.port:
        for unit in args.unit:
            successes, seen = test_target(args.host, port, unit, args.timeout, args.delay)
            modbus_seen |= seen
            if successes:
                print("\nPASS: Read {} register range(s) without an installer login.".format(
                    successes), flush=True)
                print("Working settings: host={} port={} unit={}".format(
                    args.host, port, unit), flush=True)
                return 0
    if modbus_seen:
        print("\nPARTIAL: A Modbus service answered, but no requested register data was read.")
        print("Keep the exception codes above; firmware/register support needs investigation.")
    else:
        print("\nFAIL: No valid Modbus reply. An open TCP port alone is not sufficient.")
        print("Check the SUN2000 Wi-Fi connection and close commissioning/other clients.")
        print("Retry with --timeout 15 --delay 2, or --unit <known inverter address>.")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nTest interrupted.", file=sys.stderr)
        sys.exit(130)
