#ifndef CPP_CORE_LINEAR_SOLVER_H
#define CPP_CORE_LINEAR_SOLVER_H

#pragma once

#include <cmath>
#include <algorithm>
#include <cstring>
#include "types.h"

/**
 * ============================================================================
 * PowerSim PRO High-Performance MNA Linear Solver
 * ============================================================================
 * Optimized for power electronic Modified Nodal Analysis (MNA) matrices (N <= 64).
 * Performs in-place dense Gaussian elimination with partial row pivoting,
 * dynamic regularization for singular/floating nodes, forward elimination,
 * and back-substitution.
 */

namespace powersim {

constexpr int MAX_MNA_DIM = 64;
constexpr double PIVOT_TOLERANCE = 1e-12;
constexpr double DYNAMIC_REGULARIZATION = 1e-6;
constexpr double ZERO_ELIM_TOLERANCE = 1e-15;

/**
 * In-place Dense Gaussian Elimination with Partial Row Pivoting.
 * Solves A * x = b for x, modifying A and b in-place.
 *
 * @param n Dimension of the linear system (number of unknowns).
 * @param A Pointer to contiguous n x n row-major matrix (A[i * n + j]). Overwritten in-place.
 * @param b Pointer to RHS vector of length n. Overwritten in-place.
 * @param x Pointer to output solution vector of length n.
 * @return true if solved successfully, false if inputs invalid or numerical failure.
 */
inline bool solve_linear_system(int n, double* A, double* b, double* x) {
    if (!A || !b || !x || n <= 0) {
        return false;
    }

    if (n == 1) {
        double pivot = A[0];
        if (std::fabs(pivot) < PIVOT_TOLERANCE) {
            pivot += (pivot < 0.0) ? -DYNAMIC_REGULARIZATION : DYNAMIC_REGULARIZATION;
        }
        x[0] = b[0] / pivot;
        return !std::isnan(x[0]) && !std::isinf(x[0]);
    }

    // Forward Elimination with Partial Row Pivoting
    for (int k = 0; k < n; ++k) {
        // Step 1: Find row with maximum absolute pivot in column k
        int max_row = k;
        double max_val = std::fabs(A[k * n + k]);
        for (int i = k + 1; i < n; ++i) {
            double val = std::fabs(A[i * n + k]);
            if (val > max_val) {
                max_val = val;
                max_row = i;
            }
        }

        // Step 2: Swap rows in A and RHS b if needed
        if (max_row != k) {
            for (int j = k; j < n; ++j) {
                double tmp = A[k * n + j];
                A[k * n + j] = A[max_row * n + j];
                A[max_row * n + j] = tmp;
            }
            double tmp_b = b[k];
            b[k] = b[max_row];
            b[max_row] = tmp_b;
        }

        // Step 3: Check pivot against singularity.
        // If near-zero, apply dynamic regularization to handle floating nodes cleanly.
        double pivot = A[k * n + k];
        if (std::fabs(pivot) < PIVOT_TOLERANCE) {
            double reg = (pivot < 0.0) ? -DYNAMIC_REGULARIZATION : DYNAMIC_REGULARIZATION;
            A[k * n + k] += reg;
            pivot = A[k * n + k];
        }

        // Step 4: Eliminate column k for rows k + 1 to n - 1
        for (int i = k + 1; i < n; ++i) {
            double aik = A[i * n + k];
            if (std::fabs(aik) < ZERO_ELIM_TOLERANCE) {
                A[i * n + k] = 0.0;
                continue;
            }

            double factor = aik / pivot;
            A[i * n + k] = 0.0;

            for (int j = k + 1; j < n; ++j) {
                A[i * n + j] -= factor * A[k * n + j];
            }
            b[i] -= factor * b[k];
        }
    }

    // Step 5: Back-substitution
    for (int i = n - 1; i >= 0; --i) {
        double sum = b[i];
        for (int j = i + 1; j < n; ++j) {
            sum -= A[i * n + j] * x[j];
        }

        double diag = A[i * n + i];
        if (std::fabs(diag) < PIVOT_TOLERANCE) {
            diag += (diag < 0.0) ? -DYNAMIC_REGULARIZATION : DYNAMIC_REGULARIZATION;
        }

        x[i] = sum / diag;
        if (std::isnan(x[i]) || std::isinf(x[i])) {
            return false;
        }
    }

    return true;
}

/**
 * Stamp a linear conductance g between nodes n1 and n2 into MNA matrix G.
 * Handles ground (index < 0) seamlessly.
 *
 * @param G Pointer to n x n MNA matrix (row-major).
 * @param n Dimension of matrix G.
 * @param n1 0-based index of node 1 (< 0 for ground).
 * @param n2 0-based index of node 2 (< 0 for ground).
 * @param g Conductance in Siemens.
 */
inline void stamp_conductance(double* G, int n, int n1, int n2, double g) {
    if (!G || n <= 0) return;
    if (n1 >= 0 && n1 < n) {
        G[n1 * n + n1] += g;
    }
    if (n2 >= 0 && n2 < n) {
        G[n2 * n + n2] += g;
    }
    if (n1 >= 0 && n1 < n && n2 >= 0 && n2 < n) {
        G[n1 * n + n2] -= g;
        G[n2 * n + n1] -= g;
    }
}

/**
 * Stamp a resistor r between nodes n1 and n2 into MNA matrix G.
 * Clamps r to minimum 1e-12 to prevent zero-division.
 *
 * @param G Pointer to n x n MNA matrix (row-major).
 * @param n Dimension of matrix G.
 * @param n1 0-based index of node 1 (< 0 for ground).
 * @param n2 0-based index of node 2 (< 0 for ground).
 * @param r Resistance in Ohms.
 */
inline void stamp_resistor(double* G, int n, int n1, int n2, double r) {
    double r_clamped = (r > 1e-12) ? r : 1e-12;
    stamp_conductance(G, n, n1, n2, 1.0 / r_clamped);
}

/**
 * Stamp minimum conductance to ground (gmin) on all circuit node diagonals.
 * Prevents floating node singularities in MNA formulation.
 *
 * @param G Pointer to n x n MNA matrix (row-major).
 * @param n Dimension of matrix G.
 * @param num_nodes Total number of non-ground circuit nodes.
 * @param gmin Minimum conductance in Siemens (default: 1e-9).
 */
inline void stamp_gmin(double* G, int n, int num_nodes, double gmin = 1e-9) {
    if (!G || n <= 0) return;
    int limit = (num_nodes < n) ? num_nodes : n;
    for (int i = 0; i < limit; ++i) {
        G[i * n + i] += gmin;
    }
}

/**
 * Stamp an independent voltage source branch into MNA matrix G and RHS b.
 * Voltage source branch equation: v(n1) - v(n2) = vs_val.
 *
 * @param G Pointer to n x n MNA matrix (row-major).
 * @param b Pointer to RHS vector of length n.
 * @param n Dimension of matrix G.
 * @param n1 Positive node index (< 0 for ground).
 * @param n2 Negative node index (< 0 for ground).
 * @param vs_var_idx Variable row/col index allocated for this voltage source branch.
 * @param vs_val Voltage value in Volts.
 */
inline void stamp_vsource(double* G, double* b, int n, int n1, int n2, int vs_var_idx, double vs_val) {
    if (!G || n <= 0 || vs_var_idx < 0 || vs_var_idx >= n) return;
    if (n1 >= 0 && n1 < n) {
        G[n1 * n + vs_var_idx] += 1.0;
        G[vs_var_idx * n + n1] += 1.0;
    }
    if (n2 >= 0 && n2 < n) {
        G[n2 * n + vs_var_idx] -= 1.0;
        G[vs_var_idx * n + n2] -= 1.0;
    }
    if (b) {
        b[vs_var_idx] = vs_val;
    }
}

/**
 * Stamp an independent or companion current source into RHS vector b.
 * Current leaves n2 and enters n1 (i.e. +ieq at n1, -ieq at n2).
 *
 * @param b Pointer to RHS vector of length n.
 * @param n Dimension of vector b.
 * @param n1 Entry node index (< 0 for ground).
 * @param n2 Exit node index (< 0 for ground).
 * @param ieq Equivalent current in Amperes.
 */
inline void stamp_current_source(double* b, int n, int n1, int n2, double ieq) {
    if (!b || n <= 0) return;
    if (n1 >= 0 && n1 < n) {
        b[n1] += ieq;
    }
    if (n2 >= 0 && n2 < n) {
        b[n2] -= ieq;
    }
}

} // namespace powersim

// Also expose globally for C/C++ consumers matching exact prompt signature
using powersim::solve_linear_system;
using powersim::stamp_resistor;
using powersim::stamp_gmin;
using powersim::stamp_conductance;
using powersim::stamp_vsource;
using powersim::stamp_current_source;

#endif // CPP_CORE_LINEAR_SOLVER_H
