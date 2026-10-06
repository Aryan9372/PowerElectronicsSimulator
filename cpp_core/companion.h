#ifndef CPP_CORE_COMPANION_H
#define CPP_CORE_COMPANION_H

#pragma once

#include "types.h"

#ifdef __cplusplus
#include <cmath>
#include <algorithm>
#define COMPANION_INLINE inline
#else
#include <math.h>
#define COMPANION_INLINE static inline
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ============================================================================
 * Numerical Constants and Epsilon Clamping
 * ============================================================================ */
#define COMPANION_EPS_MIN_R    1e-12   /* Minimum resistance to prevent division by zero */
#define COMPANION_EPS_MIN_DT   1e-18   /* Minimum time step */
#define COMPANION_EPS_MIN_C    1e-18   /* Minimum capacitance */
#define COMPANION_EPS_MIN_L    1e-18   /* Minimum inductance */

/* ============================================================================
 * Companion State POD Structs
 * ============================================================================ */

/**
 * Capacitor companion model state tracking structure.
 */
typedef struct CapacitorCompanion {
    int comp_id;        /* Index in global component array */
    int n1_idx;         /* Positive node index (-1 = ground) */
    int n2_idx;         /* Negative node index (-1 = ground) */
    double C;           /* Capacitance value in Farads */
    double req;         /* Companion equivalent resistance (Ohm) */
    double geq;         /* Companion equivalent conductance (Siemens = 1 / req) */
    double ieq;         /* Companion equivalent current source (A) */
    double v_prev;      /* Capacitor branch voltage at previous step (V) */
    double i_prev;      /* Capacitor branch current at previous step (A) */
} CapacitorCompanion;

/**
 * Inductor companion model state tracking structure.
 */
typedef struct InductorCompanion {
    int comp_id;        /* Index in global component array */
    int n1_idx;         /* Positive node index (-1 = ground) */
    int n2_idx;         /* Negative node index (-1 = ground) */
    double L;           /* Inductance value in Henrys */
    double req;         /* Companion equivalent resistance (Ohm) */
    double geq;         /* Companion equivalent conductance (Siemens = 1 / req) */
    double ieq;         /* Companion equivalent current source (A) */
    double v_prev;      /* Inductor branch voltage at previous step (V) */
    double i_prev;      /* Inductor branch current at previous step (A) */
} InductorCompanion;

/* ============================================================================
 * 1. Equivalent Resistance & Conductance Calculations
 * ============================================================================ */

/**
 * Compute equivalent resistance Req for Capacitor:
 *   Trapezoidal:    Req = dt / (2.0 * C)
 *   Backward-Euler: Req = dt / C
 */
COMPANION_INLINE double companion_cap_req(double C, double dt, int method) {
    double c_safe = (C < COMPANION_EPS_MIN_C) ? COMPANION_EPS_MIN_C : C;
    double dt_safe = (dt < COMPANION_EPS_MIN_DT) ? COMPANION_EPS_MIN_DT : dt;
    if (method == METHOD_TRAPEZOIDAL) {
        return dt_safe / (2.0 * c_safe);
    } else {
        return dt_safe / c_safe;
    }
}

/**
 * Compute equivalent conductance Geq = 1 / Req for Capacitor:
 *   Trapezoidal:    Geq = 2.0 * C / dt
 *   Backward-Euler: Geq = C / dt
 */
COMPANION_INLINE double companion_cap_geq(double C, double dt, int method) {
    double req = companion_cap_req(C, dt, method);
    return 1.0 / ((req < COMPANION_EPS_MIN_R) ? COMPANION_EPS_MIN_R : req);
}

/**
 * Compute equivalent resistance Req for Inductor:
 *   Trapezoidal:    Req = 2.0 * L / dt
 *   Backward-Euler: Req = L / dt
 */
COMPANION_INLINE double companion_ind_req(double L, double dt, int method) {
    double l_safe = (L < COMPANION_EPS_MIN_L) ? COMPANION_EPS_MIN_L : L;
    double dt_safe = (dt < COMPANION_EPS_MIN_DT) ? COMPANION_EPS_MIN_DT : dt;
    if (method == METHOD_TRAPEZOIDAL) {
        return (2.0 * l_safe) / dt_safe;
    } else {
        return l_safe / dt_safe;
    }
}

/**
 * Compute equivalent conductance Geq = 1 / Req for Inductor:
 *   Trapezoidal:    Geq = dt / (2.0 * L)
 *   Backward-Euler: Geq = dt / L
 */
COMPANION_INLINE double companion_ind_geq(double L, double dt, int method) {
    double req = companion_ind_req(L, dt, method);
    return 1.0 / ((req < COMPANION_EPS_MIN_R) ? COMPANION_EPS_MIN_R : req);
}

/* ============================================================================
 * 2. Companion Current (Ieq) Calculations
 * ============================================================================ */

/**
 * Compute companion current source Ieq for Capacitor:
 *   Trapezoidal:    Ieq = (2.0 * C / dt) * v_prev + i_prev
 *   Backward-Euler: Ieq = (C / dt) * v_prev
 * Matching core/engine.py:
 *   if is_trap:
 *       i_eq = (2.0 * c.value / dt) * c.v0 + i_prev
 *   else:
 *       i_eq = (c.value / dt) * c.v0
 */
COMPANION_INLINE double companion_cap_ieq(double C, double dt, double v_prev, double i_prev, int method) {
    double c_safe = (C < COMPANION_EPS_MIN_C) ? COMPANION_EPS_MIN_C : C;
    double dt_safe = (dt < COMPANION_EPS_MIN_DT) ? COMPANION_EPS_MIN_DT : dt;
    if (method == METHOD_TRAPEZOIDAL) {
        return (2.0 * c_safe / dt_safe) * v_prev + i_prev;
    } else {
        return (c_safe / dt_safe) * v_prev;
    }
}

/**
 * Compute companion current source Ieq for Inductor:
 *   Trapezoidal:    Ieq = i_prev + (dt / (2.0 * L)) * v_prev
 *   Backward-Euler: Ieq = i_prev
 * Matching core/engine.py:
 *   if is_trap:
 *       i_eq = l.i0 + (dt / (2.0 * l.value)) * v_prev
 *   else:
 *       i_eq = l.i0
 */
COMPANION_INLINE double companion_ind_ieq(double L, double dt, double v_prev, double i_prev, int method) {
    double l_safe = (L < COMPANION_EPS_MIN_L) ? COMPANION_EPS_MIN_L : L;
    double dt_safe = (dt < COMPANION_EPS_MIN_DT) ? COMPANION_EPS_MIN_DT : dt;
    if (method == METHOD_TRAPEZOIDAL) {
        return i_prev + (dt_safe / (2.0 * l_safe)) * v_prev;
    } else {
        return i_prev;
    }
}

/* ============================================================================
 * 3. MNA Conductance Stamping into G_base Matrix
 * ============================================================================ */

/**
 * Stamp a generic conductance g between nodes n1 and n2 into matrix G.
 * Stride is the row width (e.g. num_vars).
 * Ground is indicated by index < 0 (typically -1).
 */
COMPANION_INLINE void stamp_conductance(double* G, int stride, int n1, int n2, double g) {
    if (n1 >= 0) {
        G[n1 * stride + n1] += g;
    }
    if (n2 >= 0) {
        G[n2 * stride + n2] += g;
    }
    if (n1 >= 0 && n2 >= 0) {
        G[n1 * stride + n2] -= g;
        G[n2 * stride + n1] -= g;
    }
}

/**
 * Stamp a resistor r_value between nodes n1 and n2 into matrix G.
 * Matches core/engine.py: _stamp_resistor(G, n1, n2, r_value)
 */
COMPANION_INLINE void stamp_resistor(double* G, int stride, int n1, int n2, double r_value) {
    double r_safe = (r_value < COMPANION_EPS_MIN_R) ? COMPANION_EPS_MIN_R : r_value;
    double g = 1.0 / r_safe;
    stamp_conductance(G, stride, n1, n2, g);
}

/**
 * Stamp Capacitor equivalent conductance into G_base matrix.
 */
COMPANION_INLINE void stamp_capacitor_conductance(double* G, int stride, int n1, int n2, double C, double dt, int method) {
    double req = companion_cap_req(C, dt, method);
    stamp_resistor(G, stride, n1, n2, req);
}

/**
 * Stamp Inductor equivalent conductance into G_base matrix.
 */
COMPANION_INLINE void stamp_inductor_conductance(double* G, int stride, int n1, int n2, double L, double dt, int method) {
    double req = companion_ind_req(L, dt, method);
    stamp_resistor(G, stride, n1, n2, req);
}

/* ============================================================================
 * 4. RHS Vector (I) Stamping
 * ============================================================================ */

/**
 * Stamp Capacitor companion current Ieq into RHS vector I.
 * Matching core/engine.py:
 *   if n1 >= 0: I[n1] += i_eq
 *   if n2 >= 0: I[n2] -= i_eq
 */
COMPANION_INLINE void stamp_capacitor_current(double* I_rhs, int n1, int n2, double ieq) {
    if (n1 >= 0) {
        I_rhs[n1] += ieq;
    }
    if (n2 >= 0) {
        I_rhs[n2] -= ieq;
    }
}

/**
 * Stamp Inductor companion current Ieq into RHS vector I.
 * Matching core/engine.py:
 *   if n1 >= 0: I[n1] -= i_eq
 *   if n2 >= 0: I[n2] += i_eq
 */
COMPANION_INLINE void stamp_inductor_current(double* I_rhs, int n1, int n2, double ieq) {
    if (n1 >= 0) {
        I_rhs[n1] -= ieq;
    }
    if (n2 >= 0) {
        I_rhs[n2] += ieq;
    }
}

/* ============================================================================
 * 5. Branch State & Dynamic History Updates (Post-Solve)
 * ============================================================================ */

/**
 * Update Capacitor state and calculate branch current/voltage/power after MNA solve.
 * Matching core/engine.py:
 *   v1 = last_x[c.n1_idx] if c.n1_idx >= 0 else 0.0
 *   v2 = last_x[c.n2_idx] if c.n2_idx >= 0 else 0.0
 *   v_diff = v1 - v2
 *   i_b = (v_diff / c.req) - c.ieq
 *   c.v0 = v_diff
 *   if is_trap: c.i_prev = i_b
 *
 * Parameters:
 *   cap:       Capacitor companion state structure
 *   x_sol:     Solved node voltage array [num_vars]
 *   method:    Integration method (METHOD_TRAPEZOIDAL or METHOD_EULER)
 *   out_v:     Optional pointer to receive branch voltage (v1 - v2)
 *   out_i:     Optional pointer to receive branch current i_b
 *   out_p:     Optional pointer to receive branch power (v_diff * i_b)
 * Returns:
 *   Branch current i_b
 */
COMPANION_INLINE double companion_cap_update(CapacitorCompanion* cap,
                                             const double* x_sol,
                                             int method,
                                             double* out_v,
                                             double* out_i,
                                             double* out_p) {
    double v1 = (cap->n1_idx >= 0) ? x_sol[cap->n1_idx] : 0.0;
    double v2 = (cap->n2_idx >= 0) ? x_sol[cap->n2_idx] : 0.0;
    double v_diff = v1 - v2;
    double i_b = (v_diff / cap->req) - cap->ieq;

    cap->v_prev = v_diff;
    if (method == METHOD_TRAPEZOIDAL) {
        cap->i_prev = i_b;
    }

    if (out_v) *out_v = v_diff;
    if (out_i) *out_i = i_b;
    if (out_p) *out_p = v_diff * i_b;

    return i_b;
}

/**
 * Update Inductor state and calculate branch current/voltage/power after MNA solve.
 * Matching core/engine.py:
 *   v1 = last_x[l.n1_idx] if l.n1_idx >= 0 else 0.0
 *   v2 = last_x[l.n2_idx] if l.n2_idx >= 0 else 0.0
 *   v_diff = v1 - v2
 *   i_b = (v_diff / l.req) + l.ieq
 *   l.i0 = i_b
 *   if is_trap: l.v_prev = v_diff
 *
 * Parameters:
 *   ind:       Inductor companion state structure
 *   x_sol:     Solved node voltage array [num_vars]
 *   method:    Integration method (METHOD_TRAPEZOIDAL or METHOD_EULER)
 *   out_v:     Optional pointer to receive branch voltage (v1 - v2)
 *   out_i:     Optional pointer to receive branch current i_b
 *   out_p:     Optional pointer to receive branch power (v_diff * i_b)
 * Returns:
 *   Branch current i_b
 */
COMPANION_INLINE double companion_ind_update(InductorCompanion* ind,
                                             const double* x_sol,
                                             int method,
                                             double* out_v,
                                             double* out_i,
                                             double* out_p) {
    double v1 = (ind->n1_idx >= 0) ? x_sol[ind->n1_idx] : 0.0;
    double v2 = (ind->n2_idx >= 0) ? x_sol[ind->n2_idx] : 0.0;
    double v_diff = v1 - v2;
    double i_b = (v_diff / ind->req) + ind->ieq;

    ind->i_prev = i_b;
    if (method == METHOD_TRAPEZOIDAL) {
        ind->v_prev = v_diff;
    }

    if (out_v) *out_v = v_diff;
    if (out_i) *out_i = i_b;
    if (out_p) *out_p = v_diff * i_b;

    return i_b;
}

/* ============================================================================
 * 6. Companion Model Initialization & Step Functions
 * ============================================================================ */

/**
 * Initialize Capacitor companion structure.
 */
COMPANION_INLINE void companion_cap_init(CapacitorCompanion* cap,
                                         int comp_id,
                                         int n1_idx,
                                         int n2_idx,
                                         double C,
                                         double dt,
                                         int method,
                                         double v0,
                                         double i0) {
    cap->comp_id = comp_id;
    cap->n1_idx = n1_idx;
    cap->n2_idx = n2_idx;
    cap->C = C;
    cap->req = companion_cap_req(C, dt, method);
    cap->geq = 1.0 / ((cap->req < COMPANION_EPS_MIN_R) ? COMPANION_EPS_MIN_R : cap->req);
    cap->v_prev = v0;
    cap->i_prev = i0;
    cap->ieq = 0.0;
}

/**
 * Initialize Inductor companion structure.
 */
COMPANION_INLINE void companion_ind_init(InductorCompanion* ind,
                                         int comp_id,
                                         int n1_idx,
                                         int n2_idx,
                                         double L,
                                         double dt,
                                         int method,
                                         double v0,
                                         double i0) {
    ind->comp_id = comp_id;
    ind->n1_idx = n1_idx;
    ind->n2_idx = n2_idx;
    ind->L = L;
    ind->req = companion_ind_req(L, dt, method);
    ind->geq = 1.0 / ((ind->req < COMPANION_EPS_MIN_R) ? COMPANION_EPS_MIN_R : ind->req);
    ind->v_prev = v0;
    ind->i_prev = i0;
    ind->ieq = 0.0;
}

/**
 * Compute current Ieq and stamp it into I_rhs for Capacitor.
 */
COMPANION_INLINE double companion_cap_step_and_stamp(CapacitorCompanion* cap,
                                                     double* I_rhs,
                                                     double dt,
                                                     int method) {
    cap->ieq = companion_cap_ieq(cap->C, dt, cap->v_prev, cap->i_prev, method);
    stamp_capacitor_current(I_rhs, cap->n1_idx, cap->n2_idx, cap->ieq);
    return cap->ieq;
}

/**
 * Compute current Ieq and stamp it into I_rhs for Inductor.
 */
COMPANION_INLINE double companion_ind_step_and_stamp(InductorCompanion* ind,
                                                     double* I_rhs,
                                                     double dt,
                                                     int method) {
    ind->ieq = companion_ind_ieq(ind->L, dt, ind->v_prev, ind->i_prev, method);
    stamp_inductor_current(I_rhs, ind->n1_idx, ind->n2_idx, ind->ieq);
    return ind->ieq;
}

/* ============================================================================
 * 7. Batch Stamping Helpers for Engine Loops
 * ============================================================================ */

/**
 * Pre-build helper: Stamp all Capacitor and Inductor conductances into G_base matrix.
 * Loops through ComponentPOD list, identifying COMP_CAPACITOR and COMP_INDUCTOR.
 */
COMPANION_INLINE void companion_stamp_all_base(double* G_base,
                                               int stride,
                                               const ComponentPOD* comps,
                                               int num_comps,
                                               double dt,
                                               int method) {
    for (int i = 0; i < num_comps; ++i) {
        if (comps[i].type == COMP_CAPACITOR) {
            stamp_capacitor_conductance(G_base, stride, comps[i].n1_idx, comps[i].n2_idx, comps[i].value, dt, method);
        } else if (comps[i].type == COMP_INDUCTOR) {
            stamp_inductor_conductance(G_base, stride, comps[i].n1_idx, comps[i].n2_idx, comps[i].value, dt, method);
        }
    }
}

/**
 * Batch helper: Stamp all capacitor companion currents into I_rhs vector.
 */
COMPANION_INLINE void companion_stamp_all_caps(CapacitorCompanion* caps,
                                               int num_caps,
                                               double* I_rhs,
                                               double dt,
                                               int method) {
    for (int i = 0; i < num_caps; ++i) {
        companion_cap_step_and_stamp(&caps[i], I_rhs, dt, method);
    }
}

/**
 * Batch helper: Stamp all inductor companion currents into I_rhs vector.
 */
COMPANION_INLINE void companion_stamp_all_inds(InductorCompanion* inds,
                                               int num_inds,
                                               double* I_rhs,
                                               double dt,
                                               int method) {
    for (int i = 0; i < num_inds; ++i) {
        companion_ind_step_and_stamp(&inds[i], I_rhs, dt, method);
    }
}

#ifdef __cplusplus
}
#endif

#endif /* CPP_CORE_COMPANION_H */
