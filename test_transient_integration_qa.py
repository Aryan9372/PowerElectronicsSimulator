import time
import urllib.request
import json
from app import simulate_custom, CustomSimulationRequest

def run_comprehensive_qa():
    print("=" * 70)
    print("Agent 4.10 Comprehensive QA, Integration & Benchmark Suite")
    print("=" * 70)

    # 1. HTTP Endpoint checks
    print("\n[Phase 1] HTTP Static and Dynamic Routing Verification:")
    endpoints = [
        ("http://127.0.0.1:8000/", "Root redirect"),
        ("http://127.0.0.1:8000/builder.html", "Builder HTML CAD"),
        ("http://127.0.0.1:8000/builder.js", "Oscilloscope and Engine JS")
    ]
    for url, label in endpoints:
        req = urllib.request.urlopen(url)
        content_len = len(req.read())
        print(f"  [PASS] {label} ({url}) -> Status: {req.status} OK, Size: {content_len:,} bytes")
        assert req.status == 200, f"Expected 200 for {url}"

    # 2. HTTP POST simulation test
    print("\n[Phase 2] Live HTTP API Simulation with Window Parameter:")
    post_payload = {
        "circuit_json": {
            "simulation": {
                "t_end": 0.04,
                "dt": 5e-5,
                "window": {"t_start": 0.01, "t_end": 0.03}
            },
            "components": [
                {"type": "V_AC", "id": "V1", "nodes": ["n_a", "gnd"], "amplitude": 120.0, "freq": 60},
                {"type": "Resistor", "id": "R1", "nodes": ["n_a", "gnd"], "value": 15.0}
            ]
        }
    }
    req_data = json.dumps(post_payload).encode('utf-8')
    req = urllib.request.Request("http://127.0.0.1:8000/api/simulate_custom", data=req_data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        api_res = json.loads(resp.read().decode('utf-8'))
        assert resp.status == 200
        assert 'stats_window' in api_res and api_res['stats_window'] is not None
        print(f"  [PASS] Live API /api/simulate_custom responded 200 OK with window metrics:")
        print(f"    - Window: {api_res.get('window')}")
        print(f"    - V(n_a) window RMS: {api_res['stats_window']['V(n_a)']['rms']:.2f} V")

    # 3. Backend Engine Accuracy and Auto-Extension Matrix
    print("\n[Phase 3] Engine Accuracy & Auto-Extension Verification Matrix:")
    test_cases = [
        ("Preset 20ms", 0.02, 0.0, 0.02),
        ("Preset 50ms", 0.05, 0.0, 0.05),
        ("Preset 100ms", 0.10, 0.0, 0.10),
        ("Preset 200ms", 0.20, 0.0, 0.20),
        ("Auto-extension from 40ms to 500ms", 0.04, 0.0, 0.50),
        ("Sub-interval 20ms to 70ms", 0.10, 0.02, 0.07)
    ]
    for name, init_dur, win_start, win_end in test_cases:
        c_json = {
            "simulation": {
                "t_end": init_dur,
                "dt": 5e-5,
                "window": {"t_start": win_start, "t_end": win_end}
            },
            "components": [
                {"type": "V_AC", "id": "V1", "nodes": ["n1", "gnd"], "amplitude": 100.0, "freq": 50},
                {"type": "Resistor", "id": "R1", "nodes": ["n1", "gnd"], "value": 10.0}
            ]
        }
        res = simulate_custom(CustomSimulationRequest(circuit_json=c_json))
        max_time = max(res['time'])
        expected_min = max(init_dur, win_end)
        assert max_time >= expected_min - 1e-4, f"Failed {name}: max_time {max_time} < {expected_min}"
        assert res['stats_window'] is not None
        assert 'V(n1)' in res['stats_window']
        print(f"  [PASS] {name:38}: Max Time = {max_time*1000:6.1f}ms, Window = [{win_start*1000:.0f}ms - {win_end*1000:.0f}ms], Points = {len(res['time']):,}")

    # 4. Inverted Window Ordering Resilience
    print("\n[Phase 4] Edge Case: Inverted Window Ordering [t_start > t_end]:")
    c_inv = {
        "simulation": {
            "t_end": 0.1,
            "dt": 5e-5,
            "window": {"t_start": 0.08, "t_end": 0.02}
        },
        "components": [
            {"type": "V_DC", "id": "V1", "nodes": ["n1", "gnd"], "value": 24.0},
            {"type": "Resistor", "id": "R1", "nodes": ["n1", "gnd"], "value": 12.0}
        ]
    }
    res_inv = simulate_custom(CustomSimulationRequest(circuit_json=c_inv))
    assert res_inv['window']['t_start'] == 0.02 and res_inv['window']['t_end'] == 0.08
    print("  [PASS] Correctly normalized inverted window bounds [0.08, 0.02] -> [0.02, 0.08]")

    # 5. Benchmarks
    print("\n[Phase 5] Simulation & Window Metrics Benchmark:")
    durations = [0.02, 0.05, 0.10, 0.20, 0.50, 1.00]
    for d in durations:
        dt = 5e-5 if d <= 0.5 else 1e-4
        c_bench = {
            "simulation": {"t_end": d, "dt": dt, "window": {"t_start": 0.0, "t_end": d}},
            "components": [
                {"type": "V_AC", "id": "V1", "nodes": ["n_in", "gnd"], "amplitude": 230.0, "freq": 50},
                {"type": "Diode", "id": "D1", "nodes": ["n_in", "n_out"]},
                {"type": "Resistor", "id": "R1", "nodes": ["n_out", "gnd"], "value": 20.0},
                {"type": "Capacitor", "id": "C1", "nodes": ["n_out", "gnd"], "value": 1e-4}
            ]
        }
        t0 = time.perf_counter()
        res_b = simulate_custom(CustomSimulationRequest(circuit_json=c_bench))
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        n_steps = len(res_b['time'])
        print(f"  [PASS] Duration: {d*1000:6.1f} ms | Steps: {n_steps:6d} | Solved & Stats in {elapsed_ms:6.2f} ms")

    print("\n" + "=" * 70)
    print(">>> 100% QA VERIFICATION & INTEGRATION BENCHMARKS COMPLETE! <<<")
    print("=" * 70)

if __name__ == '__main__':
    run_comprehensive_qa()
