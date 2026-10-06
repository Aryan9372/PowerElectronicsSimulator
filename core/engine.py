# core/engine.py
import numpy as np
from .components import Resistor, Capacitor, Inductor, VoltageSource, Switch, Diode, Thyristor, MOSFET

class Simulator:
    """
    High-Performance Power Electronics Transient Simulator
    Uses Modified Nodal Analysis (MNA) with Pre-Stamping, Iterative Switch Consistency (PLECS/Saber method),
    and Trapezoidal / Backward-Euler integration.
    """
    def __init__(self, method='trapezoidal'):
        self.components = []
        self.nodes = set()
        self.node_map = {}
        self.voltage_sources = []
        self.method = method # 'trapezoidal' or 'backward_euler'
        
        self.t = 0.0
        self.dt = 1e-5

        # Partitioned component lists for zero-overhead inner loops
        self.resistors = []
        self.capacitors = []
        self.inductors = []
        self.switches = []
        
    def add_component(self, comp):
        self.components.append(comp)
        self.nodes.add(comp.n1)
        self.nodes.add(comp.n2)
        if isinstance(comp, VoltageSource):
            self.voltage_sources.append(comp)
        elif isinstance(comp, Resistor):
            self.resistors.append(comp)
        elif isinstance(comp, Capacitor):
            self.capacitors.append(comp)
        elif isinstance(comp, Inductor):
            self.inductors.append(comp)
        elif isinstance(comp, Switch):
            self.switches.append(comp)

    def build_maps(self, dt):
        nodes_list = list(self.nodes)
        for gnd in ['gnd', '0', 'GND']:
            if gnd in nodes_list:
                nodes_list.remove(gnd)
            
        for i, node in enumerate(nodes_list):
            self.node_map[node] = i
            
        self.num_nodes = len(self.node_map)
        self.num_vs = len(self.voltage_sources)
        self.num_vars = self.num_nodes + self.num_vs

        # Cache fast integer node indices directly on components
        for c in self.components:
            c.n1_idx = self.get_node_idx(c.n1)
            c.n2_idx = self.get_node_idx(c.n2)

        # Cache voltage source indices
        for vs_idx, vs in enumerate(self.voltage_sources):
            vs.var_idx = self.num_nodes + vs_idx

        # Precompute companion resistances for LC
        for c in self.capacitors:
            if self.method == 'trapezoidal':
                c.req = dt / (2.0 * c.value)
            else:
                c.req = dt / c.value

        for l in self.inductors:
            if self.method == 'trapezoidal':
                l.req = (2.0 * l.value) / dt
            else:
                l.req = l.value / dt

        # Pre-build G_base matrix containing all invariant conductances
        self.G_base = np.zeros((self.num_vars, self.num_vars))
        self._stamp_gmin(self.G_base)

        for r in self.resistors:
            self._stamp_resistor(self.G_base, r.n1_idx, r.n2_idx, r.value)

        for c in self.capacitors:
            self._stamp_resistor(self.G_base, c.n1_idx, c.n2_idx, c.req)

        for l in self.inductors:
            self._stamp_resistor(self.G_base, l.n1_idx, l.n2_idx, l.req)

        for vs in self.voltage_sources:
            if vs.n1_idx >= 0:
                self.G_base[vs.n1_idx, vs.var_idx] += 1.0
                self.G_base[vs.var_idx, vs.n1_idx] += 1.0
            if vs.n2_idx >= 0:
                self.G_base[vs.n2_idx, vs.var_idx] -= 1.0
                self.G_base[vs.var_idx, vs.n2_idx] -= 1.0
        
    def get_node_idx(self, node_name):
        if node_name in ['gnd', '0', 'GND']:
            return -1
        return self.node_map.get(node_name, -1)

    def _stamp_resistor(self, G, n1_idx, n2_idx, r_value):
        g = 1.0 / max(r_value, 1e-12)
        if n1_idx >= 0:
            G[n1_idx, n1_idx] += g
        if n2_idx >= 0:
            G[n2_idx, n2_idx] += g
        if n1_idx >= 0 and n2_idx >= 0:
            G[n1_idx, n2_idx] -= g
            G[n2_idx, n1_idx] -= g

    def _stamp_gmin(self, G):
        gmin = 1e-9
        for i in range(self.num_nodes):
            G[i, i] += gmin

    def run(self, t_end, dt, get_gate_signals=None):
        self.dt = dt
        self.build_maps(dt)
        
        times = np.arange(0, t_end, dt)
        n_steps = len(times)
        
        res_nodes = {node: np.zeros(n_steps) for node in self.node_map}
        res_switches = {sw.name: np.zeros(n_steps) for sw in self.switches}
        res_branch_i = {comp.name: np.zeros(n_steps) for comp in self.components}
        res_branch_v = {comp.name: np.zeros(n_steps) for comp in self.components}
        res_branch_p = {comp.name: np.zeros(n_steps) for comp in self.components}

        G = np.zeros((self.num_vars, self.num_vars))
        I = np.zeros(self.num_vars)
        last_x = np.zeros(self.num_vars)
        
        is_trap = (self.method == 'trapezoidal')

        for step_i in range(n_steps):
            t = times[step_i]
            gate_signals = get_gate_signals(t) if get_gate_signals else {}

            # Multi-pass iterative switch convergence (resolves DCM & commutation in same timestep)
            max_switch_iters = 6
            for sw_iter in range(max_switch_iters):
                np.copyto(G, self.G_base)
                I.fill(0.0)

                # Stamp switch resistances
                for sw in self.switches:
                    r_val = sw.get_resistance()
                    g = 1.0 / max(r_val, 1e-12)
                    n1, n2 = sw.n1_idx, sw.n2_idx
                    if n1 >= 0: G[n1, n1] += g
                    if n2 >= 0: G[n2, n2] += g
                    if n1 >= 0 and n2 >= 0:
                        G[n1, n2] -= g
                        G[n2, n1] -= g

                # Stamp capacitor companion currents
                for c in self.capacitors:
                    if is_trap:
                        i_prev = getattr(c, 'i_prev', 0.0)
                        i_eq = (2.0 * c.value / dt) * c.v0 + i_prev
                    else:
                        i_eq = (c.value / dt) * c.v0
                    c.ieq = i_eq
                    n1, n2 = c.n1_idx, c.n2_idx
                    if n1 >= 0: I[n1] += i_eq
                    if n2 >= 0: I[n2] -= i_eq

                # Stamp inductor companion currents
                for l in self.inductors:
                    if is_trap:
                        v_prev = getattr(l, 'v_prev', 0.0)
                        i_eq = l.i0 + (dt / (2.0 * l.value)) * v_prev
                    else:
                        i_eq = l.i0
                    l.ieq = i_eq
                    n1, n2 = l.n1_idx, l.n2_idx
                    if n1 >= 0: I[n1] -= i_eq
                    if n2 >= 0: I[n2] += i_eq

                # Stamp voltage sources
                for vs in self.voltage_sources:
                    I[vs.var_idx] = vs.get_voltage(t)

                # Solve system: G * x = I
                try:
                    last_x = np.linalg.solve(G, I)
                except np.linalg.LinAlgError:
                    G += np.eye(self.num_vars) * 1e-6
                    try:
                        last_x = np.linalg.solve(G, I)
                    except np.linalg.LinAlgError:
                        break

                # Check switch state transitions
                any_switch_changed = False
                for sw in self.switches:
                    v_n1 = last_x[sw.n1_idx] if sw.n1_idx >= 0 else 0.0
                    v_n2 = last_x[sw.n2_idx] if sw.n2_idx >= 0 else 0.0
                    v_diff = v_n1 - v_n2
                    i_trial = v_diff / sw.get_resistance()
                    gate = gate_signals.get(sw.name, False)
                    old_state = sw.state

                    if isinstance(sw, Diode):
                        sw.update_state(v_diff, i_trial)
                    elif isinstance(sw, Thyristor):
                        sw.update_state(v_diff, i_trial, gate)
                    elif isinstance(sw, MOSFET):
                        sw.update_state(v_diff, i_trial, gate)

                    if sw.state != old_state:
                        any_switch_changed = True

                if not any_switch_changed:
                    break

            # Record node voltages
            for node, idx in self.node_map.items():
                res_nodes[node][step_i] = last_x[idx]

            # Record and update dynamic component states
            for r in self.resistors:
                v1 = last_x[r.n1_idx] if r.n1_idx >= 0 else 0.0
                v2 = last_x[r.n2_idx] if r.n2_idx >= 0 else 0.0
                v_diff = v1 - v2
                i_b = v_diff / max(r.value, 1e-12)
                res_branch_v[r.name][step_i] = v_diff
                res_branch_i[r.name][step_i] = i_b
                res_branch_p[r.name][step_i] = v_diff * i_b

            for c in self.capacitors:
                v1 = last_x[c.n1_idx] if c.n1_idx >= 0 else 0.0
                v2 = last_x[c.n2_idx] if c.n2_idx >= 0 else 0.0
                v_diff = v1 - v2
                i_b = (v_diff / c.req) - c.ieq
                c.v0 = v_diff
                if is_trap: c.i_prev = i_b
                res_branch_v[c.name][step_i] = v_diff
                res_branch_i[c.name][step_i] = i_b
                res_branch_p[c.name][step_i] = v_diff * i_b

            for l in self.inductors:
                v1 = last_x[l.n1_idx] if l.n1_idx >= 0 else 0.0
                v2 = last_x[l.n2_idx] if l.n2_idx >= 0 else 0.0
                v_diff = v1 - v2
                i_b = (v_diff / l.req) + l.ieq
                l.i0 = i_b
                if is_trap: l.v_prev = v_diff
                res_branch_v[l.name][step_i] = v_diff
                res_branch_i[l.name][step_i] = i_b
                res_branch_p[l.name][step_i] = v_diff * i_b

            for sw in self.switches:
                v1 = last_x[sw.n1_idx] if sw.n1_idx >= 0 else 0.0
                v2 = last_x[sw.n2_idx] if sw.n2_idx >= 0 else 0.0
                v_diff = v1 - v2
                i_b = v_diff / sw.get_resistance()
                res_switches[sw.name][step_i] = 1.0 if sw.state else 0.0
                res_branch_v[sw.name][step_i] = v_diff
                res_branch_i[sw.name][step_i] = i_b
                res_branch_p[sw.name][step_i] = v_diff * i_b

            for vs in self.voltage_sources:
                v1 = last_x[vs.n1_idx] if vs.n1_idx >= 0 else 0.0
                v2 = last_x[vs.n2_idx] if vs.n2_idx >= 0 else 0.0
                v_diff = v1 - v2
                i_b = last_x[vs.var_idx]
                res_branch_v[vs.name][step_i] = v_diff
                res_branch_i[vs.name][step_i] = i_b
                res_branch_p[vs.name][step_i] = v_diff * i_b

        return {
            'time': times,
            'nodes': res_nodes,
            'switches': res_switches,
            'branch_i': res_branch_i,
            'branch_v': res_branch_v,
            'branch_p': res_branch_p
        }
