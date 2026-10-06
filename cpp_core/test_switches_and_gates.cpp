#include <iostream>
#include <cassert>
#include <cmath>
#include <vector>
#include "types.h"
#include "gate_signals.h"
#include "switches.h"

void test_gate_signals() {
    std::cout << "[TEST] Running test_gate_signals..." << std::endl;

    // 1. Pulse Gate Tests
    double freq = 50.0; // T = 0.02s
    // At t = 0s, angle = 0 deg
    assert(std::abs(powersim::compute_electrical_angle_deg(0.0, freq) - 0.0) < 1e-9);
    // At t = 0.005s (T/4), angle = 90 deg
    assert(std::abs(powersim::compute_electrical_angle_deg(0.005, freq) - 90.0) < 1e-5);
    // At t = 0.010s (T/2), angle = 180 deg
    assert(std::abs(powersim::compute_electrical_angle_deg(0.010, freq) - 180.0) < 1e-5);

    // Alpha = 30 deg, Width = 15 deg -> Window: [30, 45]
    // 30 deg corresponds to t = 30 / (360 * 50) = 30 / 18000 = 0.00166667 s
    double t_before = 25.0 / 18000.0;
    double t_start = 30.0 / 18000.0;
    double t_mid = 35.0 / 18000.0;
    double t_end = 45.0 / 18000.0;
    double t_after = 50.0 / 18000.0;

    assert(!powersim::evaluate_pulse_gate(t_before, freq, 30.0, 15.0));
    assert(powersim::evaluate_pulse_gate(t_start, freq, 30.0, 15.0));
    assert(powersim::evaluate_pulse_gate(t_mid, freq, 30.0, 15.0));
    assert(powersim::evaluate_pulse_gate(t_end, freq, 30.0, 15.0));
    assert(!powersim::evaluate_pulse_gate(t_after, freq, 30.0, 15.0));

    // Pulse wrapping across 360: Alpha = 350 deg, Width = 20 deg -> Window [350, 360] U [0, 10]
    double t_349 = 349.0 / 18000.0;
    double t_350 = 350.0 / 18000.0;
    double t_0 = 0.0 / 18000.0;
    double t_10 = 10.0 / 18000.0;
    double t_15 = 15.0 / 18000.0;

    assert(!powersim::evaluate_pulse_gate(t_349, freq, 350.0, 20.0));
    assert(powersim::evaluate_pulse_gate(t_350, freq, 350.0, 20.0));
    assert(powersim::evaluate_pulse_gate(t_0, freq, 350.0, 20.0));
    assert(powersim::evaluate_pulse_gate(t_10, freq, 350.0, 20.0));
    assert(!powersim::evaluate_pulse_gate(t_15, freq, 350.0, 20.0));

    // Width = 0 -> always false, Width >= 360 -> always true
    assert(!powersim::evaluate_pulse_gate(t_mid, freq, 30.0, 0.0));
    assert(powersim::evaluate_pulse_gate(t_mid, freq, 30.0, 360.0));

    // 2. PWM Gate Tests
    double pwm_freq = 1000.0; // T = 1 ms
    double duty = 25.0;       // On for 0.25 ms
    assert(powersim::evaluate_pwm_gate(0.0001, pwm_freq, duty, 0.0)); // 0.1 ms <= 0.25 ms
    assert(powersim::evaluate_pwm_gate(0.00025, pwm_freq, duty, 0.0)); // 0.25 ms <= 0.25 ms
    assert(!powersim::evaluate_pwm_gate(0.0003, pwm_freq, duty, 0.0)); // 0.3 ms > 0.25 ms
    assert(powersim::evaluate_pwm_gate(0.0011, pwm_freq, duty, 0.0)); // 1.1 ms -> 0.1 ms in cycle 2

    // PWM Phase offset: phase = 90 deg -> offset = 0.25 ms
    // t_c = (t + 0.25ms) % 1ms
    // With duty = 50% (on_time = 0.5ms):
    // At t = 0: t_c = 0.25ms <= 0.5ms -> true
    // At t = 0.25ms: t_c = 0.5ms <= 0.5ms -> true
    // At t = 0.30ms: t_c = 0.55ms > 0.5ms -> false
    assert(powersim::evaluate_pwm_gate(0.0, pwm_freq, 50.0, 90.0));
    assert(powersim::evaluate_pwm_gate(0.00025, pwm_freq, 50.0, 90.0));
    assert(!powersim::evaluate_pwm_gate(0.00030, pwm_freq, 50.0, 90.0));

    // Extreme duties
    assert(!powersim::evaluate_pwm_gate(0.0001, pwm_freq, 0.0, 0.0));
    assert(powersim::evaluate_pwm_gate(0.0009, pwm_freq, 100.0, 0.0));

    // 3. Constant Gate Tests
    assert(powersim::evaluate_constant_gate(1.0));
    assert(!powersim::evaluate_constant_gate(0.0));

    // 4. ComponentPOD gate evaluation
    ComponentPOD comp_pulse{};
    comp_pulse.gate_type = GATE_PULSE;
    comp_pulse.freq = 50.0;
    comp_pulse.gate_param1 = 30.0;
    comp_pulse.gate_param2 = 15.0;
    assert(powersim::evaluate_gate_signal(comp_pulse, t_mid));
    assert(!powersim::evaluate_gate_signal(comp_pulse, t_before));

    // C ABI
    assert(powersim_evaluate_gate(GATE_PULSE, 30.0, 15.0, 50.0, t_mid, 50.0) == 1);
    assert(powersim_evaluate_gate(GATE_PULSE, 30.0, 15.0, 50.0, t_before, 50.0) == 0);

    std::cout << "[PASS] test_gate_signals passed successfully!" << std::endl;
}

void test_switches() {
    std::cout << "[TEST] Running test_switches..." << std::endl;

    // 1. Diode State Tests
    // OFF -> ON
    assert(powersim::evaluate_diode_state(false, 5.0, 5.0 / 1e6) == true);
    // Remains OFF
    assert(powersim::evaluate_diode_state(false, -5.0, -5.0 / 1e6) == false);
    // ON -> remains ON with positive current
    assert(powersim::evaluate_diode_state(true, 0.001, 10.0) == true);
    // ON -> turns OFF when current drops to zero or reverses
    assert(powersim::evaluate_diode_state(true, 0.0, 0.0) == false);
    assert(powersim::evaluate_diode_state(true, -1.0, -10.0) == false);

    // 2. Thyristor State Tests (Latching)
    // OFF -> forward biased but no gate -> remains OFF
    assert(powersim::evaluate_thyristor_state(false, 100.0, 1e-4, false) == false);
    // OFF -> reverse biased with gate -> remains OFF
    assert(powersim::evaluate_thyristor_state(false, -100.0, -1e-4, true) == false);
    // OFF -> forward biased with gate -> turns ON!
    assert(powersim::evaluate_thyristor_state(false, 100.0, 1e-4, true) == true);

    // ON -> gate is removed, but current is 5A (> 1e-6 holding) -> stays ON (LATCHED!)
    assert(powersim::evaluate_thyristor_state(true, 0.0005, 5.0, false, 1e-6) == true);
    // ON -> current drops below holding current (e.g. 5e-7 A) -> unlatches and turns OFF!
    assert(powersim::evaluate_thyristor_state(true, 1e-10, 5e-7, false, 1e-6) == false);
    // ON -> current drops <= 0 -> turns OFF!
    assert(powersim::evaluate_thyristor_state(true, -1.0, -1.0, false, 1e-6) == false);

    // 3. MOSFET State Tests (Channel + Body Diode)
    // Gate active -> always ON
    assert(powersim::evaluate_mosfet_state(false, 10.0, 1e-5, true) == true);
    assert(powersim::evaluate_mosfet_state(false, -10.0, -1e-5, true) == true);
    assert(powersim::evaluate_mosfet_state(true, 10.0, 10.0, true) == true);

    // Gate inactive:
    // Forward v_diff (v_ds > 0) -> OFF
    assert(powersim::evaluate_mosfet_state(false, 10.0, 1e-5, false) == false);
    // Reverse v_diff (v_ds < -1e-4) -> body diode conducts -> turns ON!
    assert(powersim::evaluate_mosfet_state(false, -0.7, -0.7 / 1e6, false, true) == true);
    // Conducting via body diode, current is negative (Source -> Drain): stays ON
    assert(powersim::evaluate_mosfet_state(true, -0.001, -10.0, false, true) == true);
    // Conducting via body diode, current reverses/stops (i_trial >= 0): turns OFF!
    assert(powersim::evaluate_mosfet_state(true, 0.001, 1.0, false, true) == false);
    assert(powersim::evaluate_mosfet_state(true, 0.0, 0.0, false, true) == false);

    // Body diode disabled:
    assert(powersim::evaluate_mosfet_state(false, -0.7, -0.7 / 1e6, false, false) == false);

    // 4. Resistances and Conductances
    double ron = 1e-4;
    double roff = 1e6;
    assert(powersim::get_switch_resistance(true, ron, roff) == ron);
    assert(powersim::get_switch_resistance(false, ron, roff) == roff);
    assert(std::abs(powersim::get_switch_conductance(true, ron, roff) - 1e4) < 1e-6);
    assert(std::abs(powersim::get_switch_conductance(false, ron, roff) - 1e-6) < 1e-12);

    // 5. Stamping Test into 3x3 MNA matrix
    std::vector<double> G(9, 0.0);
    // Stamp switch between node 0 and node 1 with conductance g = 100.0
    powersim::stamp_switch_conductance(G.data(), 3, 0, 1, 100.0);
    assert(G[0 * 3 + 0] == 100.0);
    assert(G[1 * 3 + 1] == 100.0);
    assert(G[0 * 3 + 1] == -100.0);
    assert(G[1 * 3 + 0] == -100.0);

    // Ground node test: node 0 to gnd (-1)
    powersim::stamp_switch_conductance(G.data(), 3, 0, -1, 50.0);
    assert(G[0 * 3 + 0] == 150.0); // 100 + 50

    // 6. SwitchModel and SwitchNetwork Manager Test
    ComponentPOD pod_scr{};
    pod_scr.id = 101;
    pod_scr.type = COMP_THYRISTOR;
    pod_scr.n1_idx = 0;
    pod_scr.n2_idx = 1;
    pod_scr.ron = 1e-3;
    pod_scr.roff = 1e6;
    pod_scr.gate_type = GATE_CONSTANT;
    pod_scr.gate_param1 = 1.0; // gate ON

    powersim::SwitchModel sw_scr;
    sw_scr.init(pod_scr, 0);
    assert(!sw_scr.state);

    // Apply forward voltage [10V at node 0, 0V at node 1]
    double x[2] = {10.0, 0.0};
    bool changed = sw_scr.update_from_solution(x, 2, sw_scr.evaluate_gate(0.0));
    assert(changed == true);
    assert(sw_scr.state == true);
    assert(sw_scr.get_resistance() == 1e-3);

    // Now turn gate OFF, switch should remain latched as long as forward current flows
    sw_scr.gate_param1 = 0.0;
    changed = sw_scr.update_from_solution(x, 2, sw_scr.evaluate_gate(0.0));
    assert(changed == false); // no state change, remained ON
    assert(sw_scr.state == true);

    // Now reverse the voltage: node 0 is 0V, node 1 is 10V (i_trial < 0)
    double x_rev[2] = {0.0, 10.0};
    changed = sw_scr.update_from_solution(x_rev, 2, sw_scr.evaluate_gate(0.0));
    assert(changed == true); // unlatched!
    assert(sw_scr.state == false);
    assert(sw_scr.get_resistance() == 1e6);

    // SwitchNetwork Multi-Pass Iterative Verification
    powersim::SwitchNetwork net;
    net.add_switch(pod_scr, 0);
    assert(net.count == 1);

    // Reset G and stamp
    std::fill(G.begin(), G.end(), 0.0);
    net.stamp_all(G.data(), 3);
    assert(std::abs(G[0 * 3 + 0] - 1e-6) < 1e-9); // OFF state

    std::cout << "[PASS] test_switches passed successfully!" << std::endl;
}

int main() {
    std::cout << "========================================" << std::endl;
    std::cout << "PowerSim PRO C++ Switch & Gate Unit Test" << std::endl;
    std::cout << "========================================" << std::endl;

    test_gate_signals();
    test_switches();

    std::cout << "========================================" << std::endl;
    std::cout << "ALL TESTS PASSED SUCCESSFULLY!" << std::endl;
    std::cout << "========================================" << std::endl;
    return 0;
}
