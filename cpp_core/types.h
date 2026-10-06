#ifndef CPP_CORE_TYPES_H
#define CPP_CORE_TYPES_H

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/* ============================================================================
 * Component & Gate Enums
 * ============================================================================ */

typedef enum {
    COMP_RESISTOR   = 0,
    COMP_CAPACITOR  = 1,
    COMP_INDUCTOR   = 2,
    COMP_V_DC       = 3,
    COMP_V_AC       = 4,
    COMP_DIODE      = 5,
    COMP_THYRISTOR  = 6,
    COMP_MOSFET     = 7
} ComponentType;

typedef enum {
    GATE_NONE       = 0,
    GATE_PULSE      = 1,
    GATE_PWM        = 2,
    GATE_CONSTANT   = 3
} GateType;

typedef enum {
    METHOD_TRAPEZOIDAL = 0,
    METHOD_EULER       = 1
} IntegrationMethod;

/* ============================================================================
 * POD Data Structures
 * ============================================================================ */

/**
 * Component Plain Old Data (POD) representation matching Python ctypes memory layout.
 */
typedef struct {
    int id;
    int type;           /* ComponentType: 0..7 */
    int n1_idx;         /* Node 1 index (0-based, -1 or num_nodes for ground if applicable) */
    int n2_idx;         /* Node 2 index (0-based) */
    double value;       /* Resistance (Ohm), Capacitance (F), Inductance (H), or DC Voltage (V) */
    double amplitude;   /* Peak voltage amplitude (V) for AC source */
    double freq;        /* Frequency (Hz) for AC source */
    double phase_rad;   /* Initial phase (radians) for AC source */
    double ron;         /* On-state resistance (Ohm) */
    double roff;        /* Off-state resistance (Ohm) */
    double v0;          /* Initial capacitor voltage (V) */
    double i0;          /* Initial inductor current (A) */
    int gate_type;      /* GateType: 0=none, 1=pulse, 2=pwm, 3=constant */
    double gate_param1; /* delay_angle (deg) or duty (%) */
    double gate_param2; /* pulse_width (deg) or phase (deg) */
} ComponentPOD;

/**
 * Simulation Configuration POD structure.
 */
typedef struct {
    double t_end;
    double dt;
    int method;             /* IntegrationMethod: 0=trapezoidal, 1=euler */
    int num_nodes;          /* Number of independent circuit nodes (excluding ground) */
    int num_components;     /* Total number of components */
    int num_vsources;       /* Total number of independent voltage sources */
    int n_steps;            /* Total time steps allocated */
    double win_t_start;     /* Analysis window start time (s) */
    double win_t_end;       /* Analysis window end time (s) */
    double steady_t_start;  /* Steady-state window start time (s) */
    double steady_t_end;    /* Steady-state window end time (s) */
} SimConfigPOD;

/**
 * Metric / Statistics POD structure for electrical measurements.
 */
typedef struct {
    double avg;         /* Average (DC) value */
    double rms;         /* Root-Mean-Square (RMS) value */
    double pk_pk;       /* Peak-to-Peak value */
    double max_val;     /* Maximum value */
    double min_val;     /* Minimum value */
    double power;       /* Average real power (W) */
    double rf;          /* Ripple factor */
} MetricPOD;

/**
 * Simulation Results POD structure containing pointers to flat pre-allocated double buffers.
 * Buffers are allocated by caller (e.g. NumPy contiguous arrays via ctypes) and written in-place.
 */
typedef struct {
    double* time;               /* [n_steps] */
    double* node_v;             /* [num_nodes * n_steps] (row-major: node * n_steps + step) */
    double* branch_i;           /* [num_components * n_steps] */
    double* branch_v;           /* [num_components * n_steps] */
    double* branch_p;           /* [num_components * n_steps] */
    double* switches;           /* [num_components * n_steps] (1.0 = ON, 0.0 = OFF) */
    MetricPOD* stats_window;    /* [num_components] or node metrics over window */
    MetricPOD* stats_steady;    /* [num_components] metrics over steady state */
    MetricPOD* stats_transient; /* [num_components] metrics over transient window */
} SimResultsPOD;

#ifdef __cplusplus
}
#endif

#endif /* CPP_CORE_TYPES_H */
