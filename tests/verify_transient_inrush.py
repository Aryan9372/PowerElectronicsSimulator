"""
tests/verify_transient_inrush.py
Transient Inrush & Resonance Dynamics Verification Suite
Auditor: Agent 4.4 (Transient Inrush & Resonance Dynamics Auditor)

Objective:
1. Verify that RLC series step input matches second-order transfer function characteristics:
   - Damping ratio (zeta), natural frequency (omega_n), damped frequency (omega_d)
   - Peak overshoot time and peak voltage
   - Exponential damping envelope and logarithmic decrement
2. Verify that AC-to-DC uncontrolled rectifier with smoothing capacitor captures:
   - Initial transient inrush current spike at t=0 exceeding steady-state current by >3x
   - Complete capacitor pre-charging curve from 0V to settled DC level
3. Verify that viewing window [0, 20ms] isolates the startup transient dynamics,
   while [180ms, 200ms] isolates the settled steady-state periodic regime.
"""

import os
import sys
import math
import numpy as np
import pytest

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.components import Resistor, Capacitor, Inductor, VoltageSource, Diode
from core.engine import Simulator
from app import simulate_custom, CustomSimulationRequest


def test_rlc_step_overshoot_and_damping():
    """
    Constructs and simulates a series RLC circuit with step input:
    Vs = 100 V, R = 4.0 Ohm, L = 0.01 H (10 mH), C = 100 uF.

    Second-order transfer function theory:
    - omega_n = 1 / sqrt(L * C) = 1000 rad/s
    - zeta = (R / 2) * sqrt(C / L) = 0.200 (underdamped, 0 < zeta < 1)
    - omega_d = omega_n * sqrt(1 - zeta^2) = 979.7959 rad/s
    - Peak time t_p = pi / omega_d = 3.2063 ms
    - Percent overshoot M_p = exp(-pi * zeta / sqrt(1 - zeta^2)) = 52.66%
    - Peak capacitor voltage v_C(t_p) = Vs * (1 + M_p) = 152.66 V
    - Exact analytical step response:
      v_C(t) = Vs * [1 - exp(-zeta * omega_n * t) * (cos(omega_d * t) + (zeta / sqrt(1 - zeta^2)) * sin(omega_d * t))]
    """
    Vs = 100.0
    R = 4.0
    L = 0.01
    C = 100e-6

    # 1. Theoretical calculations
    wn = 1.0 / np.sqrt(L * C)
    zeta = (R / 2.0) * np.sqrt(C / L)
    wd = wn * np.sqrt(1.0 - zeta**2)
    tp_theory = np.pi / wd
    Mp_theory = np.exp(-np.pi * zeta / np.sqrt(1.0 - zeta**2))
    v_peak_theory = Vs * (1.0 + Mp_theory)
    decay_rate = zeta * wn  # 200 s^-1

    # 2. Build circuit via Simulator
    sim = Simulator(method="trapezoidal")
    sim.add_component(VoltageSource("V1", "n_in", "gnd", vtype="dc", value=Vs))
    sim.add_component(Resistor("R1", "n_in", "n1", value=R))
    sim.add_component(Inductor("L1", "n1", "n2", value=L))
    sim.add_component(Capacitor("C1", "n2", "gnd", value=C))

    dt = 1e-5  # 10 us timestep
    t_end = 0.20  # 200 ms total horizon
    res = sim.run(t_end=t_end, dt=dt)

    t = res["time"]
    vc = res["nodes"]["n2"]

    # 3. Peak overshoot verification
    idx_peak = np.argmax(vc)
    tp_sim = t[idx_peak]
    v_peak_sim = vc[idx_peak]
    Mp_sim = (v_peak_sim - Vs) / Vs

    time_err_ms = abs(tp_sim - tp_theory) * 1000.0
    volt_err = abs(v_peak_sim - v_peak_theory)
    pct_volt_err = (volt_err / v_peak_theory) * 100.0

    print(f"\n[RLC Verification] Theoretical: wn={wn:.1f} rad/s, zeta={zeta:.3f}, wd={wd:.2f} rad/s")
    print(f"[RLC Verification] Expected Peak: {v_peak_theory:.3f} V at {tp_theory * 1000:.3f} ms (Mp={Mp_theory*100:.2f}%)")
    print(f"[RLC Verification] Simulated Peak:  {v_peak_sim:.3f} V at {tp_sim * 1000:.3f} ms (Mp={Mp_sim*100:.2f}%)")
    print(f"[RLC Verification] Peak Voltage Error: {volt_err:.4f} V ({pct_volt_err:.4f}%), Time Error: {time_err_ms:.4f} ms")

    assert volt_err < 0.20, f"Peak voltage error too high: {volt_err:.4f} V"
    assert time_err_ms < 0.05, f"Peak time error too high: {time_err_ms:.4f} ms"
    assert abs(Mp_sim - Mp_theory) < 0.005, f"Overshoot mismatch: {Mp_sim:.4f} vs {Mp_theory:.4f}"

    # 4. Trajectory and damping envelope verification
    vc_analytical = Vs * (1.0 - np.exp(-decay_rate * t) * (
        np.cos(wd * t) + (zeta / np.sqrt(1.0 - zeta**2)) * np.sin(wd * t)
    ))
    rmse = np.sqrt(np.mean((vc - vc_analytical)**2))
    ss_tot = np.sum((vc - np.mean(vc))**2)
    ss_res = np.sum((vc - vc_analytical)**2)
    r2 = 1.0 - (ss_res / ss_tot)

    print(f"[RLC Verification] Full-horizon RMSE: {rmse:.4f} V, R^2 goodness of fit: {r2:.6f}")
    assert r2 > 0.9999, f"Trajectory R^2 too low: {r2}"
    assert rmse < 0.15, f"Trajectory RMSE too high: {rmse} V"

    # 5. Successive peak decay & logarithmic decrement verification
    # Find local maxima in [0, 50ms]
    peaks = []
    for i in range(1, len(vc) - 1):
        if vc[i] > vc[i - 1] and vc[i] > vc[i + 1] and vc[i] > Vs:
            peaks.append((t[i], vc[i]))
        if len(peaks) >= 3:
            break

    assert len(peaks) >= 2, "Expected at least 2 distinct oscillation peaks"
    t1, v1 = peaks[0]
    t2, v2 = peaks[1]
    # Logarithmic decrement delta = ln((v1 - Vs) / (v2 - Vs)) = zeta * wn * T_d
    T_d_theory = 2.0 * np.pi / wd
    delta_theory = decay_rate * T_d_theory
    delta_sim = np.log((v1 - Vs) / (v2 - Vs))
    delta_err = abs(delta_sim - delta_theory)

    print(f"[RLC Verification] Peak 1: {v1:.2f}V at {t1*1000:.2f}ms, Peak 2: {v2:.2f}V at {t2*1000:.2f}ms")
    print(f"[RLC Verification] Log Decrement: sim={delta_sim:.4f}, theory={delta_theory:.4f}, err={delta_err:.4f}")
    assert delta_err < 0.05, f"Logarithmic decrement mismatch: {delta_sim} vs {delta_theory}"

    # 6. Horizon contrast: [0, 20ms] vs [180ms, 200ms]
    idx_trans = np.where((t >= 0.0) & (t <= 0.02))[0]
    idx_steady = np.where((t >= 0.18) & (t <= 0.20))[0]

    pk_pk_trans = float(np.ptp(vc[idx_trans]))
    pk_pk_steady = float(np.ptp(vc[idx_steady]))
    max_steady = float(np.max(vc[idx_steady]))
    min_steady = float(np.min(vc[idx_steady]))

    print(f"[RLC Horizon] [0, 20ms] pk-pk: {pk_pk_trans:.2f} V | [180ms, 200ms] pk-pk: {pk_pk_steady:.6f} V")
    assert pk_pk_trans > 140.0, f"Transient window failed to capture resonant excursion: {pk_pk_trans} V"
    assert pk_pk_steady < 0.01, f"Settled window still oscillating: pk-pk = {pk_pk_steady} V"
    assert abs(max_steady - Vs) < 0.01, f"Settled steady-state not at DC step input: {max_steady} V"


def test_rectifier_inrush_and_steady_state_windows():
    """
    Constructs and simulates an AC to DC uncontrolled full-bridge rectifier with smoothing capacitor:
    - AC Source: 100 V peak amplitude, 50 Hz
    - Source impedance: Rs = 1.0 Ohm
    - Diode bridge: D1, D2, D3, D4
    - Smoothing capacitor: C1 = 1000 uF (uncharged at t=0, v0=0)
    - Resistive DC load: Rload = 250 Ohm
    - Total duration: 200 ms (10 full AC cycles)

    Physical phenomena under test:
    1. Transient inrush current spike at t=0 during initial capacitor charge exceeds steady-state current by >3x.
    2. Window [0, 20ms] captures the massive initial inrush spike and charging trajectory.
    3. Window [180ms, 200ms] exhibits settled, periodic steady-state ripple.
    """
    circuit_json_base = {
        "simulation": {
            "t_end": 0.20,
            "dt": 2e-5
        },
        "components": [
            {"type": "V_AC", "id": "V1", "nodes": ["ac_p_raw", "ac_n"], "amplitude": 100.0, "freq": 50.0},
            {"type": "Resistor", "id": "Rs", "nodes": ["ac_p_raw", "ac_p"], "value": 1.0},
            {"type": "Diode", "id": "D1", "nodes": ["ac_p", "dc_p"]},
            {"type": "Diode", "id": "D2", "nodes": ["gnd", "ac_n"]},
            {"type": "Diode", "id": "D3", "nodes": ["ac_n", "dc_p"]},
            {"type": "Diode", "id": "D4", "nodes": ["gnd", "ac_p"]},
            {"type": "Capacitor", "id": "C1", "nodes": ["dc_p", "gnd"], "value": 1000e-6, "v0": 0.0},
            {"type": "Resistor", "id": "Rload", "nodes": ["dc_p", "gnd"], "value": 250.0}
        ]
    }

    # Execute simulation with Window 1: [0, 20ms] (first cycle: startup transient)
    circuit_json_trans = dict(circuit_json_base)
    circuit_json_trans["simulation"] = {
        "t_end": 0.20,
        "dt": 2e-5,
        "window": {"t_start": 0.0, "t_end": 0.02}
    }
    res_trans = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json_trans))

    # Execute simulation with Window 2: [180ms, 200ms] (10th cycle: settled steady state)
    circuit_json_steady = dict(circuit_json_base)
    circuit_json_steady["simulation"] = {
        "t_end": 0.20,
        "dt": 2e-5,
        "window": {"t_start": 0.18, "t_end": 0.20}
    }
    res_steady = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json_steady))

    # 1. Verify window metadata
    assert res_trans["window"]["t_start"] == 0.0
    assert res_trans["window"]["t_end"] == 0.02
    assert res_steady["window"]["t_start"] == 0.18
    assert res_steady["window"]["t_end"] == 0.20

    # 2. Extract metrics from stats_window
    w_stats_trans = res_trans["stats_window"]
    w_stats_steady = res_steady["stats_window"]

    # Source line current inrush
    i_src_trans_max = w_stats_trans["I(Rs)"]["max"]
    i_src_steady_max = w_stats_steady["I(Rs)"]["max"]
    i_src_steady_rms = w_stats_steady["I(Rs)"]["rms"]

    # Capacitor current inrush
    i_cap_trans_max = w_stats_trans["I(C1)"]["max"]
    i_cap_steady_max = w_stats_steady["I(C1)"]["max"]
    i_cap_steady_rms = w_stats_steady["I(C1)"]["rms"]

    # DC bus voltage charging
    v_dc_trans_min = w_stats_trans["V(dc_p)"]["min"]
    v_dc_trans_max = w_stats_trans["V(dc_p)"]["max"]
    v_dc_trans_pkpk = w_stats_trans["V(dc_p)"]["pk_pk"]

    v_dc_steady_min = w_stats_steady["V(dc_p)"]["min"]
    v_dc_steady_max = w_stats_steady["V(dc_p)"]["max"]
    v_dc_steady_pkpk = w_stats_steady["V(dc_p)"]["pk_pk"]
    v_dc_steady_avg = w_stats_steady["V(dc_p)"]["avg"]

    # Calculate ratios
    ratio_src_peak_to_peak = i_src_trans_max / max(i_src_steady_max, 1e-6)
    ratio_src_peak_to_rms = i_src_trans_max / max(i_src_steady_rms, 1e-6)
    ratio_cap_peak_to_peak = i_cap_trans_max / max(i_cap_steady_max, 1e-6)

    print("\n[Rectifier Inrush Verification Results]")
    print(f"Transient Window [0, 20ms]:")
    print(f"  Line Current I(Rs) Peak : {i_src_trans_max:.3f} A")
    print(f"  Cap Current  I(C1) Peak : {i_cap_trans_max:.3f} A")
    print(f"  Cap Voltage  V(dc_p)    : min={v_dc_trans_min:.2f}V, max={v_dc_trans_max:.2f}V, pk_pk={v_dc_trans_pkpk:.2f}V")

    print(f"\nSettled Window [180ms, 200ms]:")
    print(f"  Line Current I(Rs) Peak : {i_src_steady_max:.3f} A (RMS: {i_src_steady_rms:.3f} A)")
    print(f"  Cap Current  I(C1) Peak : {i_cap_steady_max:.3f} A (RMS: {i_cap_steady_rms:.3f} A)")
    print(f"  Cap Voltage  V(dc_p)    : min={v_dc_steady_min:.2f}V, max={v_dc_steady_max:.2f}V, avg={v_dc_steady_avg:.2f}V, ripple={v_dc_steady_pkpk:.2f}V")

    print(f"\nPhysical Ratios:")
    print(f"  Inrush Line Current Peak / Steady Peak: {ratio_src_peak_to_peak:.2f}x (Criterion: > 3.0x)")
    print(f"  Inrush Line Current Peak / Steady RMS : {ratio_src_peak_to_rms:.2f}x (Criterion: > 3.0x)")
    print(f"  Capacitor Inrush Current Peak / Steady: {ratio_cap_peak_to_peak:.2f}x (Criterion: > 3.0x)")

    # Assertions
    # 1. Inrush current peak exceeds steady-state current by > 3x
    assert ratio_src_peak_to_peak > 3.0, (
        f"Inrush peak ({i_src_trans_max:.2f}A) did not exceed steady peak ({i_src_steady_max:.2f}A) by >3x! "
        f"Ratio was {ratio_src_peak_to_peak:.2f}x"
    )
    assert ratio_src_peak_to_rms > 3.0, (
        f"Inrush peak ({i_src_trans_max:.2f}A) did not exceed steady RMS ({i_src_steady_rms:.2f}A) by >3x! "
        f"Ratio was {ratio_src_peak_to_rms:.2f}x"
    )
    assert ratio_cap_peak_to_peak > 3.0, (
        f"Capacitor inrush peak ({i_cap_trans_max:.2f}A) did not exceed steady peak ({i_cap_steady_max:.2f}A) by >3x!"
    )

    # 2. Window [0, 20ms] captures the full initial charge excursion from 0V to >90V
    assert v_dc_trans_min == 0.0, f"Expected initial capacitor voltage 0.0V, got {v_dc_trans_min}"
    assert v_dc_trans_max > 90.0, f"Expected capacitor to charge >90V in first cycle, got {v_dc_trans_max}"
    assert v_dc_trans_pkpk > 90.0, f"Expected transient pk-pk >90V, got {v_dc_trans_pkpk}"

    # 3. Window [180ms, 200ms] shows settled steady-state
    # Ripple is tightly bounded (<5V pk-pk for 1000uF cap with 250 ohm load)
    assert v_dc_steady_pkpk < 5.0, f"Settled ripple too high: {v_dc_steady_pkpk} V"
    assert v_dc_steady_avg > 90.0, f"Settled average DC level unexpectedly low: {v_dc_steady_avg} V"
    assert abs(i_src_steady_max) < 6.0, f"Steady-state line peak unexpectedly high: {i_src_steady_max} A"


def test_window_parameter_auto_extension_and_slicing():
    """
    Tests edge cases:
    - Auto-extension when window end time > simulation t_end
    - Window boundary containment and precise slice indexing
    """
    circuit_json = {
        "simulation": {
            "t_end": 0.05,
            "dt": 5e-5,
            "window": {"t_start": 0.0, "t_end": 0.25}
        },
        "components": [
            {"type": "V_DC", "id": "V1", "nodes": ["n1", "gnd"], "value": 50.0},
            {"type": "Resistor", "id": "R1", "nodes": ["n1", "gnd"], "value": 25.0}
        ]
    }

    res = simulate_custom(CustomSimulationRequest(circuit_json=circuit_json))
    max_t = max(res["time"])
    assert max_t >= 0.249, f"Engine should have auto-extended t_end to 0.25s, reached {max_t}s"
    assert res["window"]["t_start"] == 0.0
    assert res["window"]["t_end"] == 0.25
    assert res["stats_window"]["V(n1)"]["avg"] == 50.0


def main():
    print("=" * 70)
    print("RUNNING TRANSIENT INRUSH & RESONANCE DYNAMICS AUDIT SUITE")
    print("=" * 70)

    print("\n--- Test 1: RLC Series Step Overshoot & Damping ---")
    test_rlc_step_overshoot_and_damping()
    print(">>> PASS: RLC Series Step Response conforms strictly to 2nd-order transfer function!")

    print("\n--- Test 2: AC-DC Rectifier Inrush & Windowed Dynamics ---")
    test_rectifier_inrush_and_steady_state_windows()
    print(">>> PASS: Rectifier inrush peak exceeds steady-state by >3x and settles cleanly!")

    print("\n--- Test 3: Window Parameter Auto-Extension & Slicing ---")
    test_window_parameter_auto_extension_and_slicing()
    print(">>> PASS: Window auto-extension and slice indexing fully operational!")

    print("\n" + "=" * 70)
    print("ALL TRANSIENT INRUSH & RESONANCE DYNAMICS TESTS PASSED (3/3)")
    print("=" * 70)


if __name__ == "__main__":
    main()
