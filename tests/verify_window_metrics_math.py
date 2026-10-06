import math
import numpy as np
import pytest
import sys
import os

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import compute_circuit_stats, simulate_custom, CustomSimulationRequest


def calc_rel_error_pct(actual: float, theoretical: float) -> float:
    """Calculate relative error percentage."""
    if abs(theoretical) < 1e-9:
        return abs(actual - theoretical) * 100.0
    return abs(actual - theoretical) / abs(theoretical) * 100.0


def test_direct_analytical_waveforms_pure_math():
    """
    Direct mathematical audit of compute_circuit_stats on pure analytical waveforms
    sampled uniformly over exactly 1 period (integer cycle N points, endpoint excluded).
    """
    print("\n--- Test: Pure Analytical Discrete Array Verification ---")
    
    # 1. DC Waveform: 24V into 10 ohm resistor
    v_dc_val = 24.0
    r_val = 10.0
    i_dc_val = v_dc_val / r_val
    p_dc_val = v_dc_val * i_dc_val # 57.6 W
    
    n_pts = 2000
    v_dc = np.full(n_pts, v_dc_val)
    i_dc = np.full(n_pts, i_dc_val)
    p_dc = v_dc * i_dc
    
    stats_dc = compute_circuit_stats(
        nodes={"n_a": v_dc},
        branch_i={"R1": i_dc},
        branch_v={"R1": v_dc},
        branch_p={"R1": p_dc}
    )
    
    v_stats = stats_dc["V(n_a)"]
    i_stats = stats_dc["I(R1)"]
    
    assert v_stats["avg"] == 24.0
    assert v_stats["rms"] == 24.0
    assert v_stats["rf"] == 0.0
    assert i_stats["avg"] == 2.4
    assert i_stats["rms"] == 2.4
    assert i_stats["power"] == 57.6
    assert i_stats["rf"] == 0.0
    print("[PASS] Direct DC: Avg=24V, RMS=24V, RF=0.0, P=57.6W exactly.")

    # 2. Sinusoidal AC Waveform: 100V peak, 50Hz, 10 ohm resistor
    # Analytical: V_rms = 100/sqrt(2) = 70.7107V, P = 500W, V_avg = 0V
    t = np.linspace(0, 0.02, n_pts, endpoint=False)
    v_ac = 100.0 * np.sin(2 * np.pi * 50.0 * t)
    i_ac = v_ac / r_val
    p_ac = v_ac * i_ac
    
    stats_ac = compute_circuit_stats(
        nodes={"n_a": v_ac},
        branch_i={"R1": i_ac},
        branch_v={"R1": v_ac},
        branch_p={"R1": p_ac}
    )
    
    v_ac_stats = stats_ac["V(n_a)"]
    i_ac_stats = stats_ac["I(R1)"]
    
    assert abs(v_ac_stats["avg"]) < 1e-4
    assert abs(v_ac_stats["rms"] - 70.71) < 0.01
    assert v_ac_stats["pk_pk"] == 200.0
    assert i_ac_stats["power"] == 500.0
    assert abs(i_ac_stats["rms"] - 7.071) < 0.01
    print("[PASS] Direct AC: Avg=0V, RMS=70.71V, Pk-Pk=200V, P=500W.")

    # 3. Half-Wave Rectified: V_peak = 100V, 50Hz, 10 ohm resistor
    # Analytical: V_avg = 100/pi = 31.831V, V_rms = 100/2 = 50.0V, RF = 1.211, P = 250W
    v_hw = np.maximum(0.0, v_ac)
    i_hw = v_hw / r_val
    p_hw = v_hw * i_hw
    
    stats_hw = compute_circuit_stats(
        nodes={"n_load": v_hw},
        branch_i={"R1": i_hw},
        branch_v={"R1": v_hw},
        branch_p={"R1": p_hw}
    )
    
    v_hw_stats = stats_hw["V(n_load)"]
    i_hw_stats = stats_hw["I(R1)"]
    
    assert abs(v_hw_stats["avg"] - 31.83) < 0.01
    assert abs(v_hw_stats["rms"] - 50.0) < 0.01
    assert abs(v_hw_stats["rf"] - 1.211) < 0.005
    assert abs(i_hw_stats["power"] - 250.0) < 0.05
    print("[PASS] Direct Half-Wave: Avg=31.83V, RMS=50.0V, RF=1.211, P=250W.")


def test_dc_circuit_simulation_window_metrics():
    """
    Circuit simulation verification:
    DC Source: 24V into 10 ohm resistor.
    Analytical Expected:
    - V_avg = 24.0 V
    - V_rms = 24.0 V
    - Ripple Factor RF = 0.0
    - I_avg = 2.4 A
    - I_rms = 2.4 A
    - Active Power P = 57.6 W
    """
    print("\n--- Test: DC Source Circuit Simulation Window Metrics ---")
    circuit_json = {
        'simulation': {
            't_end': 0.05,
            'dt': 1e-5,
            'window': {
                't_start': 0.01,
                't_end': 0.03
            }
        },
        'components': [
            {'type': 'V_DC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'value': 24.0},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 10.0}
        ]
    }
    
    res = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json))
    assert res['stats_window'] is not None, "stats_window must be computed"
    
    v_stats = res['stats_window']['V(n_a)']
    r_stats = res['stats_window']['I(R1)']
    
    # Tolerances < 0.5%
    err_v_avg = calc_rel_error_pct(v_stats['avg'], 24.0)
    err_v_rms = calc_rel_error_pct(v_stats['rms'], 24.0)
    err_p = calc_rel_error_pct(r_stats['power'], 57.6)
    
    print(f"DC Simulation V(n_a): Avg={v_stats['avg']}V (err={err_v_avg:.3f}%), "
          f"RMS={v_stats['rms']}V (err={err_v_rms:.3f}%), RF={v_stats['rf']}")
    print(f"DC Simulation I(R1): Avg={r_stats['avg']}A, RMS={r_stats['rms']}A, "
          f"Power={r_stats['power']}W (err={err_p:.3f}%)")
    
    assert err_v_avg <= 0.5, f"V_avg error {err_v_avg:.3f}% exceeds 0.5%"
    assert err_v_rms <= 0.5, f"V_rms error {err_v_rms:.3f}% exceeds 0.5%"
    assert v_stats['rf'] == 0.0, f"V_rf {v_stats['rf']} should be 0.0 for DC"
    assert err_p <= 0.5, f"Power error {err_p:.3f}% exceeds 0.5%"
    assert r_stats['rf'] == 0.0, f"I_rf {r_stats['rf']} should be 0.0 for DC"


def test_sinusoidal_ac_circuit_simulation_window_metrics():
    """
    Circuit simulation verification:
    AC Source: 100V peak, 50Hz into 10 ohm resistor.
    T = 20ms = 0.02s.
    Window tested: [0.0, 0.02s] (1 integer cycle) and [0.0, 0.04s] (2 integer cycles).
    Analytical Expected:
    - V_avg = 0.0 V
    - V_rms = 100 / sqrt(2) = 70.7107 V
    - V_pk_pk = 200.0 V
    - I_avg = 0.0 A
    - I_rms = 10 / sqrt(2) = 7.0711 A
    - Active Power P = 500.0 W
    """
    print("\n--- Test: Sinusoidal AC Circuit Simulation Window Metrics ---")
    
    # 1. Single cycle window [0.0, 0.02]
    circuit_json_1cycle = {
        'simulation': {
            't_end': 0.04,
            'dt': 1e-5,
            'window': {
                't_start': 0.0,
                't_end': 0.02
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50.0},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 10.0}
        ]
    }
    
    res1 = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json_1cycle))
    w_stats1 = res1['stats_window']
    v_stat1 = w_stats1['V(n_a)']
    r_stat1 = w_stats1['I(R1)']
    
    v_rms_theo = 100.0 / math.sqrt(2.0) # 70.7107 V
    p_theo = 500.0 # W
    i_rms_theo = 10.0 / math.sqrt(2.0) # 7.0711 A
    
    err_v_rms1 = calc_rel_error_pct(v_stat1['rms'], v_rms_theo)
    err_p1 = calc_rel_error_pct(r_stat1['power'], p_theo)
    err_i_rms1 = calc_rel_error_pct(r_stat1['rms'], i_rms_theo)
    
    print(f"AC 1-Cycle V(n_a): Avg={v_stat1['avg']}V, RMS={v_stat1['rms']}V (err={err_v_rms1:.3f}%), "
          f"Pk-Pk={v_stat1['pk_pk']}V")
    print(f"AC 1-Cycle I(R1): RMS={r_stat1['rms']}A (err={err_i_rms1:.3f}%), "
          f"Power={r_stat1['power']}W (err={err_p1:.3f}%)")
    
    assert abs(v_stat1['avg']) <= 0.1, f"AC V_avg {v_stat1['avg']} should be ~0V"
    assert err_v_rms1 <= 0.5, f"V_rms error {err_v_rms1:.3f}% exceeds 0.5%"
    assert err_p1 <= 0.5, f"Active power error {err_p1:.3f}% exceeds 0.5%"
    assert err_i_rms1 <= 0.5, f"I_rms error {err_i_rms1:.3f}% exceeds 0.5%"
    assert abs(v_stat1['pk_pk'] - 200.0) <= 1.0, f"Pk-Pk should be ~200V"

    # 2. Two-cycle window [0.0, 0.04]
    circuit_json_2cycle = {
        'simulation': {
            't_end': 0.04,
            'dt': 1e-5,
            'window': {
                't_start': 0.0,
                't_end': 0.04
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50.0},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_a', 'gnd'], 'value': 10.0}
        ]
    }
    res2 = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json_2cycle))
    w_stats2 = res2['stats_window']
    err_v_rms2 = calc_rel_error_pct(w_stats2['V(n_a)']['rms'], v_rms_theo)
    err_p2 = calc_rel_error_pct(w_stats2['I(R1)']['power'], p_theo)
    
    print(f"AC 2-Cycle V(n_a): RMS={w_stats2['V(n_a)']['rms']}V (err={err_v_rms2:.3f}%), "
          f"Power={w_stats2['I(R1)']['power']}W (err={err_p2:.3f}%)")
    assert err_v_rms2 <= 0.5
    assert err_p2 <= 0.5


def test_half_wave_rectified_circuit_simulation_window_metrics():
    """
    Circuit simulation verification:
    Half-Wave Rectifier: 100V peak, 50Hz AC source, Diode, 10 ohm load resistor.
    Analytical Theoretical Values over integer cycle:
    - V_avg = 100 / pi = 31.8310 V
    - V_rms = 100 / 2 = 50.0000 V
    - Ripple Factor RF = sqrt((pi/2)^2 - 1) = 1.2114
    - I_avg = 3.1831 A
    - I_rms = 5.0 A
    - Active Power P = (100^2) / (4 * 10) = 250.0 W
    """
    print("\n--- Test: Half-Wave Rectified Circuit Simulation Window Metrics ---")
    circuit_json = {
        'simulation': {
            't_end': 0.04,
            'dt': 1e-5,
            'window': {
                't_start': 0.0,
                't_end': 0.02
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50.0},
            {'type': 'Diode', 'id': 'D1', 'nodes': ['n_a', 'n_load'], 'ron': 1e-4, 'roff': 1e6},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_load', 'gnd'], 'value': 10.0}
        ]
    }
    
    res = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json))
    assert res['stats_window'] is not None
    
    v_load_stats = res['stats_window']['V(n_load)']
    i_load_stats = res['stats_window']['I(R1)']
    
    v_avg_theo = 100.0 / math.pi # 31.8310 V
    v_rms_theo = 100.0 / 2.0 # 50.0 V
    rf_theo = math.sqrt((math.pi / 2.0)**2 - 1.0) # 1.2114
    i_avg_theo = 10.0 / math.pi # 3.1831 A
    i_rms_theo = 5.0 # A
    p_theo = 250.0 # W
    
    err_v_avg = calc_rel_error_pct(v_load_stats['avg'], v_avg_theo)
    err_v_rms = calc_rel_error_pct(v_load_stats['rms'], v_rms_theo)
    err_rf = calc_rel_error_pct(v_load_stats['rf'], rf_theo)
    err_i_avg = calc_rel_error_pct(i_load_stats['avg'], i_avg_theo)
    err_i_rms = calc_rel_error_pct(i_load_stats['rms'], i_rms_theo)
    err_p = calc_rel_error_pct(i_load_stats['power'], p_theo)
    
    print(f"Half-Wave V(n_load): Avg={v_load_stats['avg']}V (theo={v_avg_theo:.2f}V, err={err_v_avg:.3f}%), "
          f"RMS={v_load_stats['rms']}V (theo={v_rms_theo:.2f}V, err={err_v_rms:.3f}%), "
          f"RF={v_load_stats['rf']} (theo={rf_theo:.3f}, err={err_rf:.3f}%)")
    print(f"Half-Wave I(R1): Avg={i_load_stats['avg']}A (err={err_i_avg:.3f}%), "
          f"RMS={i_load_stats['rms']}A (err={err_i_rms:.3f}%), "
          f"Power={i_load_stats['power']}W (theo={p_theo:.2f}W, err={err_p:.3f}%)")
    
    assert err_v_avg <= 0.5, f"V_avg error {err_v_avg:.3f}% exceeds 0.5%"
    assert err_v_rms <= 0.5, f"V_rms error {err_v_rms:.3f}% exceeds 0.5%"
    assert err_rf <= 0.5, f"Ripple factor error {err_rf:.3f}% exceeds 0.5%"
    assert err_i_avg <= 0.5, f"I_avg error {err_i_avg:.3f}% exceeds 0.5%"
    assert err_i_rms <= 0.5, f"I_rms error {err_i_rms:.3f}% exceeds 0.5%"
    assert err_p <= 0.5, f"Power error {err_p:.3f}% exceeds 0.5%"


def test_stats_steady_window_and_transient_consistency():
    """
    Mathematical consistency audit between stats_steady, stats_transient, and stats_window.
    - When window is aligned with the final steady-state cycle [t_end - T, t_end],
      stats_window must match stats_steady.
    - When window spans [0, t_end], stats_window must match stats_transient.
    """
    print("\n--- Test: Consistency between stats_steady, stats_transient, and stats_window ---")
    
    # Run simulation with window aligned to steady-state cycle [0.02, 0.04]
    c_json_steady = {
        'simulation': {
            't_end': 0.04,
            'dt': 1e-5,
            'window': {
                't_start': 0.02,
                't_end': 0.04
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50.0},
            {'type': 'Diode', 'id': 'D1', 'nodes': ['n_a', 'n_load'], 'ron': 1e-4, 'roff': 1e6},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_load', 'gnd'], 'value': 10.0}
        ]
    }
    
    res = simulate_custom(CustomSimulationRequest(circuit_json=c_json_steady))
    
    # Check that stats_window matches stats_steady
    sw = res['stats_window']['V(n_load)']
    ss = res['stats_steady']['V(n_load)']
    st = res['stats_transient']['V(n_load)']
    
    print(f"Aligned window [0.02, 0.04]: Window RMS={sw['rms']}, Steady RMS={ss['rms']}, Transient RMS={st['rms']}")
    assert sw['avg'] == ss['avg'], f"Window avg {sw['avg']} != Steady avg {ss['avg']}"
    assert sw['rms'] == ss['rms'], f"Window rms {sw['rms']} != Steady rms {ss['rms']}"
    assert sw['rf'] == ss['rf'], f"Window rf {sw['rf']} != Steady rf {ss['rf']}"
    
    # Run simulation with full window [0.0, 0.04]
    c_json_full = {
        'simulation': {
            't_end': 0.04,
            'dt': 1e-5,
            'window': {
                't_start': 0.0,
                't_end': 0.04
            }
        },
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'gnd'], 'amplitude': 100.0, 'freq': 50.0},
            {'type': 'Diode', 'id': 'D1', 'nodes': ['n_a', 'n_load'], 'ron': 1e-4, 'roff': 1e6},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['n_load', 'gnd'], 'value': 10.0}
        ]
    }
    
    res_full = simulate_custom(CustomSimulationRequest(circuit_json=c_json_full))
    sw_full = res_full['stats_window']['V(n_load)']
    st_full = res_full['stats_transient']['V(n_load)']
    
    print(f"Full window [0.0, 0.04]: Window RMS={sw_full['rms']}, Transient RMS={st_full['rms']}")
    assert sw_full['avg'] == st_full['avg'], f"Window avg {sw_full['avg']} != Transient avg {st_full['avg']}"
    assert sw_full['rms'] == st_full['rms'], f"Window rms {sw_full['rms']} != Transient rms {st_full['rms']}"
    assert sw_full['rf'] == st_full['rf'], f"Window rf {sw_full['rf']} != Transient rf {st_full['rf']}"
    print("[PASS] Consistency verified across steady, transient, and window statistics.")


if __name__ == '__main__':
    print("======================================================================")
    print("STARTING WINDOWED METRICS & NUMERICAL MATH VERIFICATION AUDIT")
    print("======================================================================")
    test_direct_analytical_waveforms_pure_math()
    test_dc_circuit_simulation_window_metrics()
    test_sinusoidal_ac_circuit_simulation_window_metrics()
    test_half_wave_rectified_circuit_simulation_window_metrics()
    test_stats_steady_window_and_transient_consistency()
    print("======================================================================")
    print("ALL NUMERICAL VERIFICATION TESTS PASSED WITH 100% PHYSICAL ACCURACY (<0.5% TOLERANCE)")
    print("======================================================================")
