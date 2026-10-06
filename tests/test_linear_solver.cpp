#include <iostream>
#include <cassert>
#include <cmath>
#include <chrono>
#include "../cpp_core/linear_solver.h"

int main() {
    std::cout << "====================================================\n";
    std::cout << "PowerSim PRO - Linear Solver Unit & Parity Tests\n";
    std::cout << "====================================================\n";

    // -------------------------------------------------------------
    // Test 1: Known 3x3 Standard Linear System
    // -------------------------------------------------------------
    {
        std::cout << "[Test 1] 3x3 General Linear System ... ";
        // 2*x1 + 1*x2 - 1*x3 = 8
        // -3*x1 - 1*x2 + 2*x3 = -11
        // -2*x1 + 1*x2 + 2*x3 = -3
        // Analytical solution: x1 = 2, x2 = 3, x3 = -1
        double A[9] = {
             2.0,  1.0, -1.0,
            -3.0, -1.0,  2.0,
            -2.0,  1.0,  2.0
        };
        double b[3] = { 8.0, -11.0, -3.0 };
        double x[3] = { 0.0, 0.0, 0.0 };

        bool ok = solve_linear_system(3, A, b, x);
        assert(ok && "solve_linear_system returned false for valid 3x3 system");

        assert(std::fabs(x[0] - 2.0) < 1e-10 && "x[0] mismatch");
        assert(std::fabs(x[1] - 3.0) < 1e-10 && "x[1] mismatch");
        assert(std::fabs(x[2] - (-1.0)) < 1e-10 && "x[2] mismatch");
        std::cout << "PASSED! Solution: [" << x[0] << ", " << x[1] << ", " << x[2] << "]\n";
    }

    // -------------------------------------------------------------
    // Test 2: Known 3x3 MNA System (DC Voltage Divider with Zero Diagonal)
    // -------------------------------------------------------------
    {
        std::cout << "[Test 2] 3x3 MNA DC Voltage Divider (Zero Diagonal on VS) ... ";
        // Circuit:
        // Node 0: connected to Vs (+) and R1
        // Node 1: connected to R1 and R2 to Ground (-1)
        // Vs: 10V between Node 0 and Ground (-1)
        // R1: 100 Ohm, R2: 100 Ohm
        // Variables: [v0, v1, i_vs]
        // Theoretical: v0 = 10.0V, v1 = 5.0V, i_vs = -0.05A (flowing out of source)
        double G[9] = {0};
        double I[3] = {0};
        double x[3] = {0};

        stamp_gmin(G, 3, 2, 1e-9);
        stamp_resistor(G, 3, 0, 1, 100.0);
        stamp_resistor(G, 3, 1, -1, 100.0);
        stamp_vsource(G, I, 3, 0, -1, 2, 10.0);

        // Verify diagonal on VS row is initially 0
        assert(G[2 * 3 + 2] == 0.0 && "Expected zero diagonal for voltage source row initially");

        bool ok = solve_linear_system(3, G, I, x);
        assert(ok && "solve_linear_system failed on MNA system");

        assert(std::fabs(x[0] - 10.0) < 1e-4 && "Node 0 voltage mismatch");
        assert(std::fabs(x[1] - 5.0) < 1e-4 && "Node 1 voltage mismatch");
        assert(std::fabs(x[2] - (-0.05)) < 1e-4 && "Voltage source current mismatch");
        std::cout << "PASSED! v0=" << x[0] << "V, v1=" << x[1] << "V, i_vs=" << x[2] << "A\n";
    }

    // -------------------------------------------------------------
    // Test 3: Floating / Singular Node Regularization
    // -------------------------------------------------------------
    {
        std::cout << "[Test 3] Singular / Floating Node Dynamic Regularization ... ";
        // Matrix where row 2 is completely zero (unconnected floating node)
        double A[9] = {
            1.0, 0.0, 0.0,
            0.0, 2.0, 0.0,
            0.0, 0.0, 0.0
        };
        double b[3] = { 4.0, 6.0, 0.0 };
        double x[3] = { 0.0, 0.0, 0.0 };

        bool ok = solve_linear_system(3, A, b, x);
        assert(ok && "Regularized solver must not fail on singular matrix");
        assert(std::fabs(x[0] - 4.0) < 1e-6);
        assert(std::fabs(x[1] - 3.0) < 1e-6);
        assert(!std::isnan(x[2]) && !std::isinf(x[2]));
        std::cout << "PASSED! x=[" << x[0] << ", " << x[1] << ", " << x[2] << "]\n";
    }

    // -------------------------------------------------------------
    // Test 4: Stamping Helpers Numerical Verification
    // -------------------------------------------------------------
    {
        std::cout << "[Test 4] Stamping Helpers Verification ... ";
        double G[16] = {0};
        // n = 4, stamp resistor between node 1 and 2 with R = 50 Ohm (G = 0.02)
        stamp_resistor(G, 4, 1, 2, 50.0);
        assert(std::fabs(G[1 * 4 + 1] - 0.02) < 1e-12);
        assert(std::fabs(G[2 * 4 + 2] - 0.02) < 1e-12);
        assert(std::fabs(G[1 * 4 + 2] - (-0.02)) < 1e-12);
        assert(std::fabs(G[2 * 4 + 1] - (-0.02)) < 1e-12);

        // Ground connection: node 3 to ground (-1), R = 25 Ohm (G = 0.04)
        stamp_resistor(G, 4, 3, -1, 25.0);
        assert(std::fabs(G[3 * 4 + 3] - 0.04) < 1e-12);

        // Current source injection: +2.5A into node 0, -2.5A into node 1
        double b[4] = {0};
        stamp_current_source(b, 4, 0, 1, 2.5);
        assert(std::fabs(b[0] - 2.5) < 1e-12);
        assert(std::fabs(b[1] - (-2.5)) < 1e-12);
        std::cout << "PASSED!\n";
    }

    // -------------------------------------------------------------
    // Test 5: Throughput Benchmark (100,000 solves)
    // -------------------------------------------------------------
    {
        std::cout << "[Test 5] Speed Benchmark (100,000 iterations of 3x3 MNA solve) ... ";
        constexpr int N_ITER = 100000;
        double G_template[9] = {
             0.01, -0.01, 1.0,
            -0.01,  0.02, 0.0,
             1.0,   0.0,  0.0
        };
        double b_template[3] = { 0.0, 0.0, 10.0 };
        double G[9], b[3], x[3];

        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < N_ITER; ++i) {
            std::memcpy(G, G_template, sizeof(G));
            std::memcpy(b, b_template, sizeof(b));
            solve_linear_system(3, G, b, x);
        }
        auto end = std::chrono::high_resolution_clock::now();
        std::chrono::duration<double, std::milli> elapsed_ms = end - start;

        double time_per_solve_ns = (elapsed_ms.count() * 1e6) / N_ITER;
        std::cout << "PASSED!\n";
        std::cout << "         Total time: " << elapsed_ms.count() << " ms for " << N_ITER << " solves\n";
        std::cout << "         Average time per 3x3 solve: " << time_per_solve_ns << " ns ("
                  << (N_ITER / (elapsed_ms.count() / 1000.0)) / 1e6 << " million solves/sec)\n";
    }

    std::cout << "\n>>> ALL LINEAR SOLVER TESTS COMPLETED SUCCESSFULLY! <<<\n";
    return 0;
}
