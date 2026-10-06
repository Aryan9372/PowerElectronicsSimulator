#include <iostream>
#include <vector>
#include <cassert>
#include <cmath>
#include <iomanip>
#include "../cpp_core/types.h"
#include "../cpp_core/companion.h"

#define ASSERT_NEAR(a, b, eps) \
    do { \
        if (std::abs((a) - (b)) > (eps)) { \
            std::cerr << "Assertion failed at line " << __LINE__ << ": |" << #a << " (" << (a) \
                      << ") - " << #b << " (" << (b) << ")| = " << std::abs((a) - (b)) \
                      << " > " << (eps) << std::endl; \
            exit(1); \
        } \
    } while (0)

int main() {
    std::cout << "Testing companion.h..." << std::endl;

    double dt = 1e-5;
    double C = 100e-6; // 100 uF
    double L = 10e-3;  // 10 mH

    // 1. Test Capacitor Equivalent Resistance Req
    // Trapezoidal: Req = dt / (2*C) = 1e-5 / (2 * 100e-6) = 0.05 Ohm
    double cap_req_trap = companion_cap_req(C, dt, METHOD_TRAPEZOIDAL);
    ASSERT_NEAR(cap_req_trap, 0.05, 1e-12);

    // Backward-Euler: Req = dt / C = 1e-5 / 100e-6 = 0.1 Ohm
    double cap_req_euler = companion_cap_req(C, dt, METHOD_EULER);
    ASSERT_NEAR(cap_req_euler, 0.1, 1e-12);

    // 2. Test Inductor Equivalent Resistance Req
    // Trapezoidal: Req = 2*L / dt = 2 * 10e-3 / 1e-5 = 2000.0 Ohm
    double ind_req_trap = companion_ind_req(L, dt, METHOD_TRAPEZOIDAL);
    ASSERT_NEAR(ind_req_trap, 2000.0, 1e-12);

    // Backward-Euler: Req = L / dt = 10e-3 / 1e-5 = 1000.0 Ohm
    double ind_req_euler = companion_ind_req(L, dt, METHOD_EULER);
    ASSERT_NEAR(ind_req_euler, 1000.0, 1e-12);

    // 3. Test Capacitor Ieq
    double v_prev = 12.0;
    double i_prev = 2.5;

    // Trapezoidal: Ieq = (2*C/dt)*v_prev + i_prev = (2 * 100e-6 / 1e-5) * 12.0 + 2.5 = 20.0 * 12.0 + 2.5 = 242.5 A
    double cap_ieq_trap = companion_cap_ieq(C, dt, v_prev, i_prev, METHOD_TRAPEZOIDAL);
    ASSERT_NEAR(cap_ieq_trap, 242.5, 1e-12);

    // Backward-Euler: Ieq = (C/dt)*v_prev = (100e-6 / 1e-5) * 12.0 = 10.0 * 12.0 = 120.0 A
    double cap_ieq_euler = companion_cap_ieq(C, dt, v_prev, i_prev, METHOD_EULER);
    ASSERT_NEAR(cap_ieq_euler, 120.0, 1e-12);

    // 4. Test Inductor Ieq
    v_prev = 5.0;
    i_prev = 3.0;

    // Trapezoidal: Ieq = i_prev + (dt/(2*L))*v_prev = 3.0 + (1e-5 / (2 * 10e-3)) * 5.0 = 3.0 + 0.0005 * 5.0 = 3.0025 A
    double ind_ieq_trap = companion_ind_ieq(L, dt, v_prev, i_prev, METHOD_TRAPEZOIDAL);
    ASSERT_NEAR(ind_ieq_trap, 3.0025, 1e-12);

    // Backward-Euler: Ieq = i_prev = 3.0 A
    double ind_ieq_euler = companion_ind_ieq(L, dt, v_prev, i_prev, METHOD_EULER);
    ASSERT_NEAR(ind_ieq_euler, 3.0, 1e-12);

    // 5. Test Conductance Stamping
    int stride = 3;
    std::vector<double> G(stride * stride, 0.0);
    // Stamp cap between node 0 and node 1
    stamp_capacitor_conductance(G.data(), stride, 0, 1, C, dt, METHOD_TRAPEZOIDAL);
    // Geq = 1 / 0.05 = 20.0 S
    ASSERT_NEAR(G[0 * stride + 0], 20.0, 1e-12);
    ASSERT_NEAR(G[1 * stride + 1], 20.0, 1e-12);
    ASSERT_NEAR(G[0 * stride + 1], -20.0, 1e-12);
    ASSERT_NEAR(G[1 * stride + 0], -20.0, 1e-12);

    // Stamp inductor between node 1 and ground (-1)
    stamp_inductor_conductance(G.data(), stride, 1, -1, L, dt, METHOD_TRAPEZOIDAL);
    // Geq = 1 / 2000.0 = 0.0005 S
    ASSERT_NEAR(G[1 * stride + 1], 20.0 + 0.0005, 1e-12);

    // 6. Test Current RHS Stamping
    std::vector<double> I_rhs(stride, 0.0);
    stamp_capacitor_current(I_rhs.data(), 0, 1, 10.0);
    // Node 0: +10.0, Node 1: -10.0
    ASSERT_NEAR(I_rhs[0], 10.0, 1e-12);
    ASSERT_NEAR(I_rhs[1], -10.0, 1e-12);

    stamp_inductor_current(I_rhs.data(), 1, -1, 4.0);
    // Node 1: -4.0 (for inductor, n1 receives -ieq)
    ASSERT_NEAR(I_rhs[1], -10.0 - 4.0, 1e-12);

    // 7. Test Struct Updates
    CapacitorCompanion cap;
    companion_cap_init(&cap, 0, 0, 1, C, dt, METHOD_TRAPEZOIDAL, 10.0, 0.0);
    ASSERT_NEAR(cap.req, 0.05, 1e-12);
    ASSERT_NEAR(cap.v_prev, 10.0, 1e-12);

    I_rhs.assign(stride, 0.0);
    companion_cap_step_and_stamp(&cap, I_rhs.data(), dt, METHOD_TRAPEZOIDAL);
    // ieq = (2 * 100e-6 / 1e-5) * 10.0 + 0.0 = 200.0 A
    ASSERT_NEAR(cap.ieq, 200.0, 1e-12);
    ASSERT_NEAR(I_rhs[0], 200.0, 1e-12);
    ASSERT_NEAR(I_rhs[1], -200.0, 1e-12);

    // Suppose solved node voltages are: v0 = 12.0, v1 = 1.0 -> v_diff = 11.0
    double x_sol[3] = {12.0, 1.0, 0.0};
    double out_v, out_i, out_p;
    double i_b = companion_cap_update(&cap, x_sol, METHOD_TRAPEZOIDAL, &out_v, &out_i, &out_p);
    // i_b = (v_diff / req) - ieq = (11.0 / 0.05) - 200.0 = 220.0 - 200.0 = 20.0 A
    ASSERT_NEAR(i_b, 20.0, 1e-12);
    ASSERT_NEAR(out_v, 11.0, 1e-12);
    ASSERT_NEAR(out_i, 20.0, 1e-12);
    ASSERT_NEAR(out_p, 220.0, 1e-12);
    ASSERT_NEAR(cap.v_prev, 11.0, 1e-12);
    ASSERT_NEAR(cap.i_prev, 20.0, 1e-12);

    std::cout << "All companion model tests PASSED successfully!" << std::endl;
    return 0;
}
