"""
tests/verify_conduction_sync.py
Verification script for Current Flow & Switch Glow Conduction Synchronization
in PowerSim PRO across the transient horizon.

Verifies:
1. Single-Phase Full-Bridge Rectifier with thyristors at alpha = 60 degrees.
2. In positive half-cycle (alpha < theta < 180 deg): T1 and T2 are active (glow ON)
   and conduction currents are strictly positive.
3. In negative half-cycle (180 + alpha < theta < 360 deg): T3 and T4 are active (glow ON)
   and conduction currents are strictly positive.
4. Switch state arrays in simulation output match instantaneous branch currents.
5. Canvas scrubbing algorithm (getSimulationStepIndex) synchronizes electron particle
   flow direction and switch glow state across arbitrary transient scrub points.
"""

import sys
import os
import math
import numpy as np

# Ensure project root is in python module search path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import simulate_custom, CustomSimulationRequest, get_gate_signals_func
from core.parser import build_from_json


def get_simulation_step_index_py(times, scrubbed_time_ms):
    """
    Python implementation mirroring getSimulationStepIndex() in static/builder.js
    Fast binary search for closest time in array.
    """
    if len(times) == 0:
        return 0
    target_time_sec = scrubbed_time_ms / 1000.0
    target_time_sec = max(times[0], min(times[-1], target_time_sec))

    low = 0
    high = len(times) - 1
    while low <= high:
        mid = (low + high) >> 1
        if times[mid] < target_time_sec:
            low = mid + 1
        elif times[mid] > target_time_sec:
            high = mid - 1
        else:
            return mid

    if high < 0:
        return 0
    if low >= len(times):
        return len(times) - 1
    return low if abs(times[low] - target_time_sec) < abs(times[high] - target_time_sec) else high


def test_full_bridge_thyristor_conduction_sync():
    print("======================================================================")
    print("TEST: Single-Phase Full-Bridge Thyristor Rectifier Conduction Sync")
    print("      alpha = 60 degrees, f = 50 Hz, V_peak = 325.27 V")
    print("======================================================================")

    freq = 50.0
    period = 1.0 / freq  # 0.02 s = 20 ms
    v_peak = 230.0 * math.sqrt(2)  # ~325.27 V
    alpha_deg = 60.0
    r_val = 20.0
    t_end = 0.04  # 2 full cycles (40 ms)
    dt = 2e-5     # 20 us step

    circuit_json = {
        'simulation': {'t_end': t_end, 'dt': dt},
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'n_b'], 'amplitude': v_peak, 'freq': freq, 'phase': 0.0},
            # Bridge switches
            {'type': 'Thyristor', 'id': 'T1', 'nodes': ['n_a', 'dc_p'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Thyristor', 'id': 'T2', 'nodes': ['gnd', 'n_b'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Thyristor', 'id': 'T3', 'nodes': ['n_b', 'dc_p'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Thyristor', 'id': 'T4', 'nodes': ['gnd', 'n_a'], 'ron': 0.001, 'roff': 1e6},
            # Resistive Load
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['dc_p', 'gnd'], 'value': r_val}
        ],
        'control': {
            'T1': {'type': 'pulse', 'delay_angle': alpha_deg, 'width': 20.0, 'freq': freq},
            'T2': {'type': 'pulse', 'delay_angle': alpha_deg, 'width': 20.0, 'freq': freq},
            'T3': {'type': 'pulse', 'delay_angle': 180.0 + alpha_deg, 'width': 20.0, 'freq': freq},
            'T4': {'type': 'pulse', 'delay_angle': 180.0 + alpha_deg, 'width': 20.0, 'freq': freq}
        }
    }

    req = CustomSimulationRequest(circuit_json=circuit_json)
    res = simulate_custom(req)

    times = np.array(res['time'])
    t1_sw = np.array(res['switches']['T1'])
    t2_sw = np.array(res['switches']['T2'])
    t3_sw = np.array(res['switches']['T3'])
    t4_sw = np.array(res['switches']['T4'])

    t1_i = np.array(res['branch_i']['T1'])
    t2_i = np.array(res['branch_i']['T2'])
    t3_i = np.array(res['branch_i']['T3'])
    t4_i = np.array(res['branch_i']['T4'])
    r1_i = np.array(res['branch_i']['R1'])

    print(f"Total time points simulated: {len(times)}")
    print(f"Time span: {times[0]*1000:.2f} ms -> {times[-1]*1000:.2f} ms")

    # ------------------------------------------------------------------
    # Step 1: Angle calculation across cycles
    # ------------------------------------------------------------------
    t_cycle = times % period
    theta_deg = (t_cycle / period) * 360.0

    # Margin of 2.0 degrees to avoid single-timestep boundary ambiguity
    margin = 2.0

    # ------------------------------------------------------------------
    # Step 2: Zone 1 verification: alpha < theta < 180 deg (60 to 180 deg)
    # T1 and T2 must be ACTIVE (1.0) and conduction current > 0
    # T3 and T4 must be INACTIVE (0.0)
    # ------------------------------------------------------------------
    z1_mask = (theta_deg > alpha_deg + margin) & (theta_deg < 180.0 - margin)
    z1_count = np.sum(z1_mask)
    print(f"\n[Zone 1: {alpha_deg} < theta < 180 deg] Samples: {z1_count}")
    assert z1_count > 0, "No samples found in Zone 1"

    t1_active_z1 = np.all(t1_sw[z1_mask] == 1.0)
    t2_active_z1 = np.all(t2_sw[z1_mask] == 1.0)
    t3_inactive_z1 = np.all(t3_sw[z1_mask] == 0.0)
    t4_inactive_z1 = np.all(t4_sw[z1_mask] == 0.0)

    t1_curr_pos_z1 = np.all(t1_i[z1_mask] > 0.05)
    t2_curr_pos_z1 = np.all(t2_i[z1_mask] > 0.05)
    r1_curr_pos_z1 = np.all(r1_i[z1_mask] > 0.05)

    print(f"  T1 switch state == 1.0: {t1_active_z1}")
    print(f"  T2 switch state == 1.0: {t2_active_z1}")
    print(f"  T3 switch state == 0.0: {t3_inactive_z1}")
    print(f"  T4 switch state == 0.0: {t4_inactive_z1}")
    print(f"  T1 current positive (>0.05 A, max={np.max(t1_i[z1_mask]):.2f} A): {t1_curr_pos_z1}")
    print(f"  T2 current positive (>0.05 A, max={np.max(t2_i[z1_mask]):.2f} A): {t2_curr_pos_z1}")
    print(f"  R1 load current positive (>0.05 A): {r1_curr_pos_z1}")

    assert t1_active_z1, "T1 was not active in Zone 1"
    assert t2_active_z1, "T2 was not active in Zone 1"
    assert t3_inactive_z1, "T3 was unexpectedly active in Zone 1"
    assert t4_inactive_z1, "T4 was unexpectedly active in Zone 1"
    assert t1_curr_pos_z1, "T1 conduction current is not strictly positive in Zone 1"
    assert t2_curr_pos_z1, "T2 conduction current is not strictly positive in Zone 1"
    assert r1_curr_pos_z1, "R1 load current is not positive in Zone 1"

    # ------------------------------------------------------------------
    # Step 3: Zone 2 verification: 180 + alpha < theta < 360 deg (240 to 360 deg)
    # T3 and T4 must be ACTIVE (1.0) and conduction current > 0
    # T1 and T2 must be INACTIVE (0.0)
    # ------------------------------------------------------------------
    z2_mask = (theta_deg > 180.0 + alpha_deg + margin) & (theta_deg < 360.0 - margin)
    z2_count = np.sum(z2_mask)
    print(f"\n[Zone 2: 240 < theta < 360 deg] Samples: {z2_count}")
    assert z2_count > 0, "No samples found in Zone 2"

    t3_active_z2 = np.all(t3_sw[z2_mask] == 1.0)
    t4_active_z2 = np.all(t4_sw[z2_mask] == 1.0)
    t1_inactive_z2 = np.all(t1_sw[z2_mask] == 0.0)
    t2_inactive_z2 = np.all(t2_sw[z2_mask] == 0.0)

    t3_curr_pos_z2 = np.all(t3_i[z2_mask] > 0.05)
    t4_curr_pos_z2 = np.all(t4_i[z2_mask] > 0.05)
    r1_curr_pos_z2 = np.all(r1_i[z2_mask] > 0.05)

    print(f"  T3 switch state == 1.0: {t3_active_z2}")
    print(f"  T4 switch state == 1.0: {t4_active_z2}")
    print(f"  T1 switch state == 0.0: {t1_inactive_z2}")
    print(f"  T2 switch state == 0.0: {t2_inactive_z2}")
    print(f"  T3 current positive (>0.05 A, max={np.max(t3_i[z2_mask]):.2f} A): {t3_curr_pos_z2}")
    print(f"  T4 current positive (>0.05 A, max={np.max(t4_i[z2_mask]):.2f} A): {t4_curr_pos_z2}")
    print(f"  R1 load current positive (>0.05 A): {r1_curr_pos_z2}")

    assert t3_active_z2, "T3 was not active in Zone 2"
    assert t4_active_z2, "T4 was not active in Zone 2"
    assert t1_inactive_z2, "T1 was unexpectedly active in Zone 2"
    assert t2_inactive_z2, "T2 was unexpectedly active in Zone 2"
    assert t3_curr_pos_z2, "T3 conduction current is not strictly positive in Zone 2"
    assert t4_curr_pos_z2, "T4 conduction current is not strictly positive in Zone 2"
    assert r1_curr_pos_z2, "R1 load current is not positive in Zone 2"

    # ------------------------------------------------------------------
    # Step 4: Verification of OFF Intervals: 0 <= theta < alpha and 180 <= theta < 240
    # In resistive mode, all switches must be OFF and current near zero
    # ------------------------------------------------------------------
    off1_mask = (theta_deg >= margin) & (theta_deg < alpha_deg - margin)
    off2_mask = (theta_deg >= 180.0 + margin) & (theta_deg < 180.0 + alpha_deg - margin)
    off_mask = off1_mask | off2_mask
    print(f"\n[OFF Intervals: 0 < theta < {alpha_deg} and 180 < theta < 240 deg] Samples: {np.sum(off_mask)}")

    for sw in ['T1', 'T2', 'T3', 'T4']:
        sw_state_off = np.all(np.array(res['switches'][sw])[off_mask] == 0.0)
        assert sw_state_off, f"{sw} was not OFF in idle angle intervals"
    print("  All thyristors confirmed OFF during firing delay intervals.")

    # ------------------------------------------------------------------
    # Step 5: Switch state array correlation to instantaneous branch currents
    # ------------------------------------------------------------------
    print("\n[Switch State vs Branch Current Correlation Verification]")
    particle_threshold = 0.005  # builder.js threshold in drawCurrentFlowParticles

    for sw in ['T1', 'T2', 'T3', 'T4']:
        s_arr = np.array(res['switches'][sw])
        i_arr = np.array(res['branch_i'][sw])

        # When switch is ON (state == 1.0):
        on_indices = np.where(s_arr == 1.0)[0]
        on_currents = i_arr[on_indices]
        assert len(on_indices) > 0, f"No ON samples for {sw}"
        assert np.all(on_currents >= 0.0), f"{sw} had negative current while ON!"
        assert np.mean(on_currents) > 5.0, f"{sw} average ON current too low: {np.mean(on_currents)}"

        # When switch is OFF (state == 0.0):
        off_indices = np.where(s_arr == 0.0)[0]
        off_currents = np.abs(i_arr[off_indices])
        max_leakage = np.max(off_currents)
        assert max_leakage < 1e-3, f"{sw} OFF leakage too high: {max_leakage} A"
        assert max_leakage < particle_threshold, f"{sw} OFF leakage exceeded particle flow threshold!"

        print(f"  {sw}: ON samples={len(on_indices)}, Mean I={np.mean(on_currents):.2f} A, Max I={np.max(on_currents):.2f} A")
        print(f"        OFF samples={len(off_indices)}, Max Leakage={max_leakage:.6e} A (< {particle_threshold} A threshold)")

    # ------------------------------------------------------------------
    # Step 6: Canvas Scrubbing Synchronization Across Transient Horizon
    # Simulates user scrubbing to test scrubbedTimeMs -> stepIdx -> switch glow / particle state
    # ------------------------------------------------------------------
    print("\n[Scrubbing Synchronization Verification Across Transient Horizon]")
    test_scrub_points_ms = [
        0.0,    # Beginning: idle
        2.0,    # theta = 36 deg: idle (OFF)
        3.5,    # theta = 63 deg: just after alpha firing (T1+T2 ON)
        6.67,   # theta = 120 deg: mid positive conduction (T1+T2 ON)
        9.5,    # theta = 171 deg: late positive conduction (T1+T2 ON)
        11.0,   # theta = 198 deg: idle between cycles (OFF)
        13.5,   # theta = 243 deg: just after 2nd pulse (T3+T4 ON)
        16.67,  # theta = 300 deg: mid negative conduction (T3+T4 ON)
        19.5,   # theta = 351 deg: late negative conduction (T3+T4 ON)
        23.5,   # Cycle 2: theta = 63 deg (T1+T2 ON)
        26.67,  # Cycle 2: theta = 120 deg (T1+T2 ON)
        33.5,   # Cycle 2: theta = 243 deg (T3+T4 ON)
        36.67,  # Cycle 2: theta = 300 deg (T3+T4 ON)
        40.0    # End of horizon: clamped
    ]

    for scrub_ms in test_scrub_points_ms:
        idx = get_simulation_step_index_py(times, scrub_ms)
        t_sec = times[idx]
        deg = ((t_sec % period) / period) * 360.0

        t1_state = res['switches']['T1'][idx] > 0.5
        t2_state = res['switches']['T2'][idx] > 0.5
        t3_state = res['switches']['T3'][idx] > 0.5
        t4_state = res['switches']['T4'][idx] > 0.5

        t1_cur = res['branch_i']['T1'][idx]
        t2_cur = res['branch_i']['T2'][idx]
        t3_cur = res['branch_i']['T3'][idx]
        t4_cur = res['branch_i']['T4'][idx]

        # Determine expected states based on deg
        if 60.5 <= deg <= 179.5:
            expected_active = {'T1', 'T2'}
        elif 240.5 <= deg <= 359.5:
            expected_active = {'T3', 'T4'}
        else:
            expected_active = set()

        active_found = set()
        if t1_state: active_found.add('T1')
        if t2_state: active_found.add('T2')
        if t3_state: active_found.add('T3')
        if t4_state: active_found.add('T4')

        # Check electron particle animation rules
        particles_flowing = {}
        for sw_id, i_val in [('T1', t1_cur), ('T2', t2_cur), ('T3', t3_cur), ('T4', t4_cur)]:
            particles_flowing[sw_id] = abs(i_val) >= particle_threshold

        flowing_found = {sw_id for sw_id, flowing in particles_flowing.items() if flowing}

        # Verify exact match between glow state and active expected conductors
        if expected_active:
            assert active_found == expected_active, (
                f"Mismatch at scrub {scrub_ms:.2f} ms (deg={deg:.1f}): expected {expected_active}, got {active_found}"
            )
            assert flowing_found == expected_active, (
                f"Particle mismatch at scrub {scrub_ms:.2f} ms: expected {expected_active}, got {flowing_found}"
            )

        print(f"  Scrub {scrub_ms:5.2f} ms -> Step {idx:4d} (t={t_sec*1000:5.2f} ms, theta={deg:5.1f}°): "
              f"Active Glow={sorted(list(active_found)) or 'ALL OFF'}, "
              f"Particles={sorted(list(flowing_found)) or 'QUIESCENT'}")

    print("\n>>> TEST 1: RESISTIVE LOAD CONDUCTION SYNCHRONIZATION PASSED! <<<")


def test_full_bridge_thyristor_rl_load():
    print("\n======================================================================")
    print("TEST 2: Full-Bridge Thyristor Rectifier with Inductive (RL) Load")
    print("        alpha = 60 degrees, R = 10 ohm, L = 20 mH")
    print("======================================================================")

    freq = 50.0
    v_peak = 230.0 * math.sqrt(2)
    alpha_deg = 60.0

    circuit_json = {
        'simulation': {'t_end': 0.04, 'dt': 2e-5},
        'components': [
            {'type': 'V_AC', 'id': 'V1', 'nodes': ['n_a', 'n_b'], 'amplitude': v_peak, 'freq': freq, 'phase': 0.0},
            {'type': 'Thyristor', 'id': 'T1', 'nodes': ['n_a', 'dc_p'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Thyristor', 'id': 'T2', 'nodes': ['gnd', 'n_b'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Thyristor', 'id': 'T3', 'nodes': ['n_b', 'dc_p'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Thyristor', 'id': 'T4', 'nodes': ['gnd', 'n_a'], 'ron': 0.001, 'roff': 1e6},
            {'type': 'Inductor', 'id': 'L1', 'nodes': ['dc_p', 'load_mid'], 'value': 0.02},
            {'type': 'Resistor', 'id': 'R1', 'nodes': ['load_mid', 'gnd'], 'value': 10.0}
        ],
        'control': {
            'T1': {'type': 'pulse', 'delay_angle': alpha_deg, 'width': 20.0, 'freq': freq},
            'T2': {'type': 'pulse', 'delay_angle': alpha_deg, 'width': 20.0, 'freq': freq},
            'T3': {'type': 'pulse', 'delay_angle': 180.0 + alpha_deg, 'width': 20.0, 'freq': freq},
            'T4': {'type': 'pulse', 'delay_angle': 180.0 + alpha_deg, 'width': 20.0, 'freq': freq}
        }
    }

    res = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json))
    times = np.array(res['time'])
    t1_sw = np.array(res['switches']['T1'])
    t2_sw = np.array(res['switches']['T2'])
    t3_sw = np.array(res['switches']['T3'])
    t4_sw = np.array(res['switches']['T4'])

    t1_i = np.array(res['branch_i']['T1'])
    t2_i = np.array(res['branch_i']['T2'])
    t3_i = np.array(res['branch_i']['T3'])
    t4_i = np.array(res['branch_i']['T4'])

    # Switch conduction current consistency:
    for sw, s_arr, i_arr in [('T1', t1_sw, t1_i), ('T2', t2_sw, t2_i), ('T3', t3_sw, t3_i), ('T4', t4_sw, t4_i)]:
        on_idx = np.where(s_arr == 1.0)[0]
        off_idx = np.where(s_arr == 0.0)[0]
        assert len(on_idx) > 0, f"No ON states for {sw}"
        assert np.all(i_arr[on_idx] >= 0.0), f"{sw} conducted reverse current while ON"
        assert np.max(np.abs(i_arr[off_idx])) < 0.005, f"{sw} OFF leakage exceeded 5mA"
        print(f"  RL {sw}: ON steps={len(on_idx)}, Mean ON I={np.mean(i_arr[on_idx]):.2f} A, Max OFF I={np.max(np.abs(i_arr[off_idx])):.6e} A")

    print(">>> TEST 2: RL LOAD CONDUCTION SYNCHRONIZATION PASSED! <<<")


def test_api_simulate_endpoint():
    print("\n======================================================================")
    print("TEST 3: Standard /api/simulate Endpoint Conduction Verification")
    print("        alpha = 60 degrees, R = 10 ohm, L = 10 mH, V_rms = 230 V")
    print("======================================================================")
    from app import simulate, SimulationRequest
    req = SimulationRequest(alpha=60.0, r_val=10.0, l_val=0.01, v_rms=230.0)
    res = simulate(req)

    v_load = np.array(res['v_load'])
    i_load = np.array(res['i_load'])

    avg_v = res['metrics']['avg_v']
    avg_i = res['metrics']['avg_i']
    print(f"  Calculated avg_v: {avg_v} V, avg_i: {avg_i} A, power: {res['metrics']['power']} W")

    assert avg_v > 100.0, f"Expected avg_v > 100 V for alpha=60 deg full-bridge, got {avg_v}"
    assert avg_i > 10.0, f"Expected avg_i > 10 A, got {avg_i}"
    assert np.all(i_load >= -1e-6), "Load current should be unidirectional (rectified)"
    print(">>> TEST 3: /api/simulate ENDPOINT PASSED! <<<")


if __name__ == '__main__':
    test_full_bridge_thyristor_conduction_sync()
    test_full_bridge_thyristor_rl_load()
    test_api_simulate_endpoint()

