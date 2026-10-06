"""
Benchmark Suite: Transient Waveform Viewing Duration Performance & Speed
PowerSim PRO - Agent 4.1 (Performance & Speed Benchmark Specialist)

Benchmarks:
1. MNA Solver loop execution time (sim.run)
2. Windowed stats calculation time (stats_window)
3. Array slicing performance across transient time horizons
4. JSON serialization time and payload memory footprint
5. Direct /api/simulate_custom execution time
6. Live HTTP endpoint roundtrip latency (http://127.0.0.1:8000/api/simulate_custom)
7. Assertions: all transient durations under 200 ms execute in < 150 ms.
"""

import sys
import os
import time
import json
import urllib.request
import urllib.error
import numpy as np

# Add parent directory to path to import app and core
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.parser import build_from_json
from app import simulate_custom, CustomSimulationRequest, compute_circuit_stats

# Benchmark circuit: Full-Bridge Rectifier with LC Filter & Load
BENCHMARK_CIRCUIT = {
    'simulation': {
        't_end': 0.04,
        'dt': 5e-5,
        'window': {'t_start': 0.0, 't_end': 0.02}
    },
    'components': [
        {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'n_b'], 'amplitude': 325.0, 'freq': 50.0},
        {'type': 'Diode', 'id': 'D1', 'nodes': ['n_a', 'dc_p']},
        {'type': 'Diode', 'id': 'D2', 'nodes': ['n_b', 'gnd']},
        {'type': 'Diode', 'id': 'D3', 'nodes': ['gnd', 'n_a']},
        {'type': 'Diode', 'id': 'D4', 'nodes': ['gnd', 'n_b']},
        {'type': 'Inductor', 'id': 'L1', 'nodes': ['dc_p', 'mid'], 'value': 0.01},
        {'type': 'Capacitor', 'id': 'C1', 'nodes': ['mid', 'gnd'], 'value': 100e-6},
        {'type': 'Resistor', 'id': 'R1', 'nodes': ['mid', 'gnd'], 'value': 20.0}
    ]
}

TARGET_DURATIONS = [
    (0.02, "20 ms"),
    (0.05, "50 ms"),
    (0.10, "100 ms"),
    (0.20, "200 ms"),
    (0.50, "500 ms"),
    (1.00, "1.0 s"),
    (2.00, "2.0 s"),
]

def run_single_benchmark(t_end: float, dt: float = 5e-5, window_ratio: float = 0.5):
    """
    Executes a detailed benchmark for a specific simulation horizon t_end.
    Measures each stage:
    - Parser / Circuit setup
    - MNA Solver loop
    - Array slicing for viewing window
    - Windowed stats calculation
    - Full payload formatting & JSON serialization
    - Memory footprint (raw arrays + JSON)
    - Full simulate_custom() pipeline call
    - HTTP endpoint roundtrip (if server is reachable)
    """
    circuit = json.loads(json.dumps(BENCHMARK_CIRCUIT))
    win_end = t_end * window_ratio
    circuit['simulation']['t_end'] = t_end
    circuit['simulation']['dt'] = dt
    circuit['simulation']['window'] = {
        't_start': 0.0,
        't_end': win_end
    }

    # 1. Parsing stage
    t_start = time.perf_counter()
    sim, params = build_from_json(circuit)
    t_parse = (time.perf_counter() - t_start) * 1000.0

    # 2. MNA Solver Execution
    t_start = time.perf_counter()
    results = sim.run(t_end=t_end, dt=dt)
    t_mna = (time.perf_counter() - t_start) * 1000.0

    time_arr = results['time']
    num_steps = len(time_arr)

    # 3. Array Slicing for Transient Viewing Window
    t_start = time.perf_counter()
    idx_window = np.where((time_arr >= -1e-9) & (time_arr <= win_end + 1e-9))[0]
    sliced_nodes = {k: v[idx_window] for k, v in results['nodes'].items()}
    sliced_i = {k: v[idx_window] for k, v in results['branch_i'].items()}
    t_slice = (time.perf_counter() - t_start) * 1000.0

    # 4. Windowed Stats Calculation (stats_window)
    t_start = time.perf_counter()
    stats_window = compute_circuit_stats(
        results['nodes'], results['branch_i'], results['branch_v'], results['branch_p'], idx_window
    )
    t_stats_window = (time.perf_counter() - t_start) * 1000.0

    # 5. Full Stats Calculation (steady + transient + window)
    t_start = time.perf_counter()
    t_cycle = 1.0 / 50.0
    t_steady_start = max(0.0, t_end - t_cycle)
    idx_steady = np.where(time_arr >= (t_steady_start - 1e-9))[0]
    stats_steady = compute_circuit_stats(
        results['nodes'], results['branch_i'], results['branch_v'], results['branch_p'], idx_steady
    )
    stats_transient = compute_circuit_stats(
        results['nodes'], results['branch_i'], results['branch_v'], results['branch_p'], slice(None)
    )
    t_stats_total = (time.perf_counter() - t_start) * 1000.0 + t_stats_window

    # 6. JSON Object Construction & Serialization
    t_start = time.perf_counter()
    json_obj = {
        "time": time_arr.tolist(),
        "nodes": {k: v.tolist() for k, v in results['nodes'].items()},
        "branch_i": {k: v.tolist() for k, v in results['branch_i'].items()},
        "branch_v": {k: v.tolist() for k, v in results['branch_v'].items()},
        "branch_p": {k: v.tolist() for k, v in results['branch_p'].items()},
        "switches": {k: v.tolist() for k, v in results.get('switches', {}).items()},
        "steady_window": {"t_start": float(t_steady_start), "t_end": float(t_end), "cycle_period": float(t_cycle)},
        "stats_steady": stats_steady,
        "stats_transient": stats_transient,
        "stats_window": stats_window,
        "stats": stats_steady,
        "window": {"t_start": 0.0, "t_end": float(win_end)}
    }
    serialized_str = json.dumps(json_obj)
    t_json_serialize = (time.perf_counter() - t_start) * 1000.0

    # Memory Footprint
    # Raw NumPy array bytes:
    numpy_bytes = time_arr.nbytes
    for v in results['nodes'].values():
        numpy_bytes += v.nbytes
    for v in results['branch_i'].values():
        numpy_bytes += v.nbytes
    for v in results['branch_v'].values():
        numpy_bytes += v.nbytes
    for v in results['branch_p'].values():
        numpy_bytes += v.nbytes
    for v in results.get('switches', {}).values():
        numpy_bytes += v.nbytes

    json_bytes = len(serialized_str.encode('utf-8'))

    # 7. End-to-End simulate_custom direct call
    req = CustomSimulationRequest(circuit_json=circuit)
    t_start = time.perf_counter()
    res_direct = simulate_custom(req)
    t_simulate_custom = (time.perf_counter() - t_start) * 1000.0

    # 8. Live HTTP roundtrip (if server is up)
    t_http = None
    http_url = 'http://127.0.0.1:8000/api/simulate_custom'
    try:
        http_payload = json.dumps({'circuit_json': circuit}).encode('utf-8')
        http_req = urllib.request.Request(
            http_url,
            data=http_payload,
            headers={'Content-Type': 'application/json'}
        )
        t_start = time.perf_counter()
        with urllib.request.urlopen(http_req, timeout=60.0) as resp:
            resp_bytes = resp.read()
            _ = json.loads(resp_bytes.decode('utf-8'))
        t_http = (time.perf_counter() - t_start) * 1000.0
    except Exception as e:
        print(f"HTTP benchmark note: {e}")
        t_http = None

    return {
        't_end': t_end,
        'num_steps': num_steps,
        't_parse_ms': t_parse,
        't_mna_ms': t_mna,
        't_slice_ms': t_slice,
        't_stats_window_ms': t_stats_window,
        't_stats_total_ms': t_stats_total,
        't_json_serialize_ms': t_json_serialize,
        't_simulate_custom_ms': t_simulate_custom,
        't_http_ms': t_http,
        'numpy_bytes': numpy_bytes,
        'json_bytes': json_bytes
    }


def run_benchmark_suite(num_runs=3):
    """
    Executes multiple benchmark passes across all target horizons and computes averages.
    """
    print("=" * 80)
    print(" PowerSim PRO - Transient Simulation Performance & Speed Benchmark Suite ")
    print("=" * 80)
    print(f"Sampling across {len(TARGET_DURATIONS)} transient horizons ({num_runs} iterations each)...")
    print(f"Circuit: Full-Bridge Rectifier with LC filter, 8 components, dt = 50 µs")
    print("-" * 80)

    # Warmup run
    run_single_benchmark(0.02)

    results_table = []

    for t_end, label in TARGET_DURATIONS:
        runs = []
        for _ in range(num_runs):
            data = run_single_benchmark(t_end)
            runs.append(data)

        # Average results safely
        valid_http = [r['t_http_ms'] for r in runs if r['t_http_ms'] is not None]
        avg_http = float(np.mean(valid_http)) if valid_http else None

        avg = {
            'label': label,
            't_end': t_end,
            'num_steps': runs[0]['num_steps'],
            't_mna_ms': float(np.mean([r['t_mna_ms'] for r in runs])),
            't_slice_ms': float(np.mean([r['t_slice_ms'] for r in runs])),
            't_stats_window_ms': float(np.mean([r['t_stats_window_ms'] for r in runs])),
            't_stats_total_ms': float(np.mean([r['t_stats_total_ms'] for r in runs])),
            't_json_serialize_ms': float(np.mean([r['t_json_serialize_ms'] for r in runs])),
            't_simulate_custom_ms': float(np.mean([r['t_simulate_custom_ms'] for r in runs])),
            't_http_ms': avg_http,
            'numpy_bytes': runs[0]['numpy_bytes'],
            'json_bytes': runs[0]['json_bytes']
        }
        results_table.append(avg)

    # Print summary table
    header = (
        f"{'Horizon':<8} | {'Steps':<7} | {'MNA Loop':<10} | {'Slice':<8} | "
        f"{'StatsWin':<9} | {'JSON Ser':<9} | {'SimulateCustom':<15} | {'HTTP Latency':<12} | {'JSON (KB)':<9}"
    )
    print(header)
    print("-" * len(header))

    for r in results_table:
        http_str = f"{r['t_http_ms']:8.2f} ms" if r['t_http_ms'] is not None else "N/A"
        row = (
            f"{r['label']:<8} | {r['num_steps']:<7d} | {r['t_mna_ms']:7.2f} ms | {r['t_slice_ms']:5.3f} ms | "
            f"{r['t_stats_window_ms']:6.2f} ms | {r['t_json_serialize_ms']:6.2f} ms | {r['t_simulate_custom_ms']:12.2f} ms | "
            f"{http_str:<12} | {r['json_bytes']/1024:7.1f} KB"
        )
        print(row)

    print("-" * len(header))

    # Assertions
    print("\n[VERIFICATION OF INTERACTIVE RESPONSE SLA]")
    all_passed = True
    for r in results_table:
        dur_ms = r['t_end'] * 1000.0
        if dur_ms < 200.0:
            exec_time = r['t_simulate_custom_ms']
            http_time = r['t_http_ms']
            passed = exec_time < 150.0
            status = "PASSED" if passed else "FAILED"
            print(f" - Duration {r['label']} ({dur_ms:.0f} ms): direct={exec_time:.2f} ms (< 150 ms target) -> {status}")
            if not passed:
                all_passed = False
            assert exec_time < 150.0, f"Duration {r['label']} took {exec_time:.2f} ms, exceeding 150 ms threshold!"

        # Also verify 200 ms snappy threshold
        if abs(dur_ms - 200.0) < 1.0:
            exec_time = r['t_simulate_custom_ms']
            print(f" - Duration 200 ms: direct={exec_time:.2f} ms (< 150 ms target) -> {'PASSED' if exec_time < 150 else 'ACCEPTABLE'}")
            # Assert 200 ms is snappy (< 150 ms or close)
            assert exec_time < 150.0, f"Duration 200 ms took {exec_time:.2f} ms, exceeding 150 ms target!"

    print(f"\nALL SLA THRESHOLDS (<150 ms for durations <= 200 ms): {'SUCCESS' if all_passed else 'FAILURE'}")
    return results_table


def test_transient_speed_benchmark():
    """Pytest entrypoint for the benchmark test."""
    results = run_benchmark_suite(num_runs=2)
    for r in results:
        dur_ms = r['t_end'] * 1000.0
        if dur_ms < 200.0:
            assert r['t_simulate_custom_ms'] < 150.0, f"Horizon {r['label']} exceeded 150 ms threshold"
    assert True


if __name__ == '__main__':
    run_benchmark_suite(num_runs=3)
