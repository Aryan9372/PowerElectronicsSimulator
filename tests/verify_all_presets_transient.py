import json
import math
import os
import subprocess
import requests
import pytest

SERVER_URL = "http://127.0.0.1:8000/api/simulate_custom"

# Core presets explicitly required, plus all other presets from builder.js
PRESET_NAMES = [
    # Core presets from specifications
    'buck',
    'boost',
    'buck_boost',
    'cuk',
    'sepic',
    'half_wave',
    'half_wave_scr',
    'full_bridge_diode',
    'full_bridge_thyristor',
    'three_phase_bridge_diode',
    'three_phase_bridge_scr',
    # Additional extended presets in builder.js
    'semi_converter',
    'three_phase_half_wave_diode',
    'three_phase_half_wave_scr',
    'three_phase_semi_converter',
    'h_bridge_inverter',
    'three_phase_inverter',
    'inverter_leg'
]

DURATIONS_MS = [20, 100, 200]

def extract_preset_payloads_via_node():
    """Extract circuit payloads directly from static/builder.js using Node.js."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    builder_js_path = os.path.join(base_dir, 'static', 'builder.js')
    
    node_script = f"""
    const fs = require('fs');
    const js = fs.readFileSync({json.dumps(builder_js_path)}, 'utf-8');

    global.components = [];
    global.groundNodes = new Set();
    global.probedNodes = new Set();
    global.activeChannels = new Set();
    global.compIdCounter = 1;
    global.selectedComp = null;
    global.lastSimResults = null;
    global.hasPendingSimulateRequest = false;
    global.cachedNetData = null;
    global.gridSize = 30;
    global.renderEmptyPlot = () => {{}};
    global.updatePropsInspector = () => {{}};
    global.resetStats = () => {{}};
    global.resumeSweep = () => {{}};
    global.runSimulation = () => {{}};
    global.invalidateNets = () => {{ global.cachedNetData = null; }};

    eval(js.substring(js.indexOf('function createComponent'), js.indexOf('// -------------------------------------------------------------\\n// Netlist & Connectivity Analysis')));
    eval(js.substring(js.indexOf('function computeElectricalNets'), js.indexOf('// -------------------------------------------------------------\\n// Playback & Speed Controls')));
    eval(js.substring(js.indexOf('function loadPreset(name)'), js.indexOf('setTimeout(() => {{\\n    loadPreset(\\'full_bridge_thyristor\\');')));

    function getPresetPayload(presetName, durationMs) {{
        loadPreset(presetName);
        const {{ netMap }} = computeElectricalNets();

        let maxFreq = 50.0;
        global.components.forEach(c => {{
            if (c.props && c.props.freq && c.props.freq > maxFreq) {{
                maxFreq = c.props.freq;
            }}
        }});

        let simCycles = 10;
        let t_end = simCycles * (1.0 / maxFreq);
        if (durationMs !== null && (durationMs / 1000.0) > t_end) {{
            t_end = durationMs / 1000.0;
        }}

        let dt = Math.max(1e-5, (1.0 / maxFreq) / 100.0);
        if (maxFreq >= 1000 && dt > (1.0 / maxFreq) / 50.0) {{
            dt = Math.max(1e-6, (1.0 / maxFreq) / 80.0);
        }}

        const circuitPayload = {{
            simulation: {{ t_end: t_end, dt: dt, cycle_count: simCycles }},
            components: [],
            control: {{}}
        }};

        if (durationMs !== null) {{
            circuitPayload.window = {{
                t_start: 0.0,
                t_end: durationMs / 1000.0
            }};
        }}

        global.components.forEach(c => {{
            if (c.type === 'Wire') return;

            const n1 = netMap['N_' + Math.round(c.p1.x/global.gridSize) + '_' + Math.round(c.p1.y/global.gridSize)] || 'GND';
            const n2 = netMap['N_' + Math.round(c.p2.x/global.gridSize) + '_' + Math.round(c.p2.y/global.gridSize)] || 'GND';

            const item = {{
                id: c.id,
                type: c.type,
                nodes: [n1, n2]
            }};

            if (c.type === 'Resistor') {{
                item.value = Math.max(c.props.value, 1e-4);
            }} else if (c.type === 'Inductor') {{
                item.value = Math.max(c.props.value * 1e-3, 1e-6);
            }} else if (c.type === 'Capacitor') {{
                item.value = Math.max(c.props.value * 1e-6, 1e-9);
                item.v0 = c.props.v0 || 0;
            }} else if (c.type === 'V_AC') {{
                item.amplitude = c.props.amplitude;
                item.freq = c.props.freq;
                item.phase = (c.props.phase || 0) * Math.PI / 180.0;
                item.phase_unit = 'rad';
            }} else if (c.type === 'V_DC') {{
                item.value = c.props.value;
            }} else if (c.type === 'Diode') {{
                item.ron = c.props.ron;
                item.roff = c.props.roff;
            }} else if (c.type === 'Thyristor') {{
                item.ron = c.props.ron;
                item.roff = c.props.roff;
                circuitPayload.control[c.id] = {{
                    type: 'pulse',
                    delay_angle: c.props.delay_angle,
                    width: c.props.width,
                    freq: c.props.freq
                }};
            }} else if (c.type === 'MOSFET') {{
                item.ron = c.props.ron;
                item.roff = c.props.roff;
                item.body_diode = c.props.body_diode;
                circuitPayload.control[c.id] = {{
                    type: c.props.ctrl_type,
                    freq: c.props.freq,
                    duty: c.props.duty,
                    phase: c.props.phase,
                    delay_angle: c.props.delay_angle,
                    width: c.props.width
                }};
            }}

            circuitPayload.components.push(item);
        }});

        return circuitPayload;
    }}

    const presets = {json.dumps(PRESET_NAMES)};
    const out = {{}};
    for (const p of presets) {{
        out[p] = getPresetPayload(p, 100);
    }}
    console.log(JSON.stringify(out));
    """
    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    return json.loads(res.stdout)

def get_preset_payload(preset_name: str, duration_ms: float) -> dict:
    """Get the simulation payload for a given preset and transient viewing duration."""
    cache_path = os.path.join(os.path.dirname(__file__), 'presets_cache.json')
    payload = None
    
    try:
        extracted = extract_preset_payloads_via_node()
        if preset_name in extracted:
            payload = extracted[preset_name]
    except Exception:
        pass
        
    if payload is None and os.path.exists(cache_path):
        with open(cache_path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
            if preset_name in cache:
                payload = cache[preset_name]['payload_template']
                
    if payload is None:
        raise ValueError(f"Could not load payload for preset '{preset_name}'")

    # Clone payload and adjust for duration_ms
    circuit_json = json.loads(json.dumps(payload))
    t_view = duration_ms / 1000.0

    # Auto-extend simulation duration if view window exceeds t_end
    current_t_end = circuit_json.get('simulation', {}).get('t_end', 0.04)
    if t_view > current_t_end:
        circuit_json['simulation']['t_end'] = t_view

    circuit_json['window'] = {
        't_start': 0.0,
        't_end': t_view
    }

    return circuit_json

def run_preset_simulation_test(preset_name: str, duration_ms: float):
    """Executes a simulation request for a preset and transient viewing duration, asserting all requirements."""
    circuit_json = get_preset_payload(preset_name, duration_ms)
    req_body = {"circuit_json": circuit_json}

    response = requests.post(SERVER_URL, json=req_body, timeout=30)

    # 1. Assert Status Code 200 OK
    assert response.status_code == 200, (
        f"[{preset_name} @ {duration_ms}ms] Expected HTTP 200, got {response.status_code}: {response.text}"
    )

    data = response.json()

    # 2. Assert Time vector exists and covers window
    assert "time" in data and len(data["time"]) > 0, (
        f"[{preset_name} @ {duration_ms}ms] 'time' array missing or empty"
    )
    max_time = max(data["time"])
    expected_view_time = duration_ms / 1000.0
    dt_actual = data["time"][1] - data["time"][0] if len(data["time"]) > 1 else 1e-4
    assert max_time >= expected_view_time - dt_actual - 1e-6, (
        f"[{preset_name} @ {duration_ms}ms] Solved max time {max_time:.4f}s is less than view duration {expected_view_time:.4f}s (dt={dt_actual:.6f}s)"
    )

    # 3. Assert All node voltages exist and are non-empty
    assert "nodes" in data and len(data["nodes"]) > 0, (
        f"[{preset_name} @ {duration_ms}ms] 'nodes' dict missing or empty"
    )
    for node_name, v_series in data["nodes"].items():
        assert isinstance(v_series, list) and len(v_series) > 0, (
            f"[{preset_name} @ {duration_ms}ms] Node voltage array for {node_name} is empty"
        )
        assert len(v_series) == len(data["time"]), (
            f"[{preset_name} @ {duration_ms}ms] Node voltage length mismatch for {node_name}"
        )

    # 4. Assert All branch currents exist and are non-empty
    assert "branch_i" in data and len(data["branch_i"]) > 0, (
        f"[{preset_name} @ {duration_ms}ms] 'branch_i' dict missing or empty"
    )
    for comp_id, i_series in data["branch_i"].items():
        assert isinstance(i_series, list) and len(i_series) > 0, (
            f"[{preset_name} @ {duration_ms}ms] Branch current array for {comp_id} is empty"
        )
        assert len(i_series) == len(data["time"]), (
            f"[{preset_name} @ {duration_ms}ms] Branch current length mismatch for {comp_id}"
        )

    # 5. Assert stats_window is correctly returned and populated
    assert "stats_window" in data, (
        f"[{preset_name} @ {duration_ms}ms] 'stats_window' missing from response"
    )
    assert data["stats_window"] is not None, (
        f"[{preset_name} @ {duration_ms}ms] 'stats_window' is None"
    )
    assert isinstance(data["stats_window"], dict) and len(data["stats_window"]) > 0, (
        f"[{preset_name} @ {duration_ms}ms] 'stats_window' is not a non-empty dictionary"
    )

    # 6. Assert metrics in stats_window have valid avg, rms, pk_pk
    # Every node and branch must have an entry in stats_window
    for node_name in data["nodes"].keys():
        key = f"V({node_name})"
        assert key in data["stats_window"], (
            f"[{preset_name} @ {duration_ms}ms] stats_window missing metric for {key}"
        )
        m = data["stats_window"][key]
        assert "avg" in m and isinstance(m["avg"], (int, float)) and not math.isnan(m["avg"])
        assert "rms" in m and isinstance(m["rms"], (int, float)) and not math.isnan(m["rms"])
        assert "pk_pk" in m and isinstance(m["pk_pk"], (int, float)) and not math.isnan(m["pk_pk"])
        assert m["rms"] >= 0.0, f"[{preset_name} @ {duration_ms}ms] {key} RMS should be >= 0, got {m['rms']}"
        assert m["pk_pk"] >= 0.0, f"[{preset_name} @ {duration_ms}ms] {key} pk_pk should be >= 0, got {m['pk_pk']}"

    for comp_id in data["branch_i"].keys():
        key = f"I({comp_id})"
        assert key in data["stats_window"], (
            f"[{preset_name} @ {duration_ms}ms] stats_window missing metric for {key}"
        )
        m = data["stats_window"][key]
        assert "avg" in m and isinstance(m["avg"], (int, float)) and not math.isnan(m["avg"])
        assert "rms" in m and isinstance(m["rms"], (int, float)) and not math.isnan(m["rms"])
        assert "pk_pk" in m and isinstance(m["pk_pk"], (int, float)) and not math.isnan(m["pk_pk"])
        assert m["rms"] >= 0.0, f"[{preset_name} @ {duration_ms}ms] {key} RMS should be >= 0, got {m['rms']}"
        assert m["pk_pk"] >= 0.0, f"[{preset_name} @ {duration_ms}ms] {key} pk_pk should be >= 0, got {m['pk_pk']}"

    # 7. Assert window metadata matches
    assert "window" in data, f"[{preset_name} @ {duration_ms}ms] 'window' metadata missing"
    assert abs(data["window"]["t_start"] - 0.0) < 1e-6
    assert abs(data["window"]["t_end"] - expected_view_time) < 1e-6

    return {
        "nodes_count": len(data["nodes"]),
        "branches_count": len(data["branch_i"]),
        "window_metrics_count": len(data["stats_window"]),
        "time_steps": len(data["time"]),
        "max_time": max_time
    }

# Parameterized test for pytest
@pytest.mark.parametrize("preset_name", PRESET_NAMES)
@pytest.mark.parametrize("duration_ms", DURATIONS_MS)
def test_preset_transient_window(preset_name, duration_ms):
    run_preset_simulation_test(preset_name, duration_ms)

def main():
    print("=" * 80)
    print(" PowerSim PRO: Transient Viewing Duration Verification for All Preset Circuits")
    print(f" Target API: {SERVER_URL}")
    print(f" Presets to test: {len(PRESET_NAMES)}")
    print(f" Viewing durations per preset: {DURATIONS_MS} ms")
    print(f" Total test runs: {len(PRESET_NAMES) * len(DURATIONS_MS)}")
    print("=" * 80)

    total_runs = 0
    passed_runs = 0
    failed_runs = 0
    results_summary = []

    for preset in PRESET_NAMES:
        print(f"\n--- Testing Preset: {preset} ---")
        for dur in DURATIONS_MS:
            total_runs += 1
            try:
                res_info = run_preset_simulation_test(preset, dur)
                passed_runs += 1
                status_str = "PASS"
                print(
                    f"  [OK] {preset:<28} @ {dur:>3}ms | "
                    f"Nodes: {res_info['nodes_count']:>2} | "
                    f"Branches: {res_info['branches_count']:>2} | "
                    f"Metrics: {res_info['window_metrics_count']:>2} | "
                    f"Steps: {res_info['time_steps']:>5} | "
                    f"Max T: {res_info['max_time']:.3f}s"
                )
                results_summary.append({
                    "preset": preset,
                    "duration_ms": dur,
                    "status": "PASS",
                    "nodes": res_info["nodes_count"],
                    "branches": res_info["branches_count"],
                    "metrics": res_info["window_metrics_count"]
                })
            except Exception as e:
                failed_runs += 1
                print(f"  [FAIL] {preset:<28} @ {dur:>3}ms | Error: {e}")
                results_summary.append({
                    "preset": preset,
                    "duration_ms": dur,
                    "status": "FAIL",
                    "error": str(e)
                })

    print("\n" + "=" * 80)
    print(f" TEST RUN SUMMARY")
    print(f" Total Runs:  {total_runs}")
    print(f" Passed:      {passed_runs} ({passed_runs/total_runs*100:.1f}%)")
    print(f" Failed:      {failed_runs}")
    print("=" * 80)

    if failed_runs == 0:
        print(">>> 100% PASS RATE CONFIRMED FOR ALL PRESET CIRCUITS ACROSS ALL DURATIONS! <<<\n")
        return 0
    else:
        print(">>> SOME TESTS FAILED! <<<\n")
        return 1

if __name__ == '__main__':
    exit(main())
