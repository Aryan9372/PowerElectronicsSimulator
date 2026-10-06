# core/engine.py
import numpy as np
from .components import Resistor, Capacitor, Inductor, VoltageSource, Switch, Diode, Thyristor, MOSFET

class Simulator:
    def __init__(self):
        self.components = []
        self.nodes = set()
        self.node_map = {} # map node name to index
        self.voltage_sources = []
        
        self.t = 0.0
        self.dt = 1e-5
        
    def add_component(self, comp):
        self.components.append(comp)
        self.nodes.add(comp.n1)
        self.nodes.add(comp.n2)
        if isinstance(comp, VoltageSource):
            self.voltage_sources.append(comp)

    def build_maps(self):
        # Remove ground node from matrix
        nodes_list = list(self.nodes)
        for gnd in ['gnd', '0', 'GND']:
            if gnd in nodes_list:
                nodes_list.remove(gnd)
            
        for i, node in enumerate(nodes_list):
            self.node_map[node] = i
            
        self.num_nodes = len(self.node_map)
        self.num_vs = len(self.voltage_sources)
        self.num_vars = self.num_nodes + self.num_vs
        
    def get_node_idx(self, node_name):
        if node_name in ['gnd', '0', 'GND']:
            return -1
        return self.node_map[node_name]

    def _stamp_resistor(self, G, n1_idx, n2_idx, r_value):
        g = 1.0 / r_value
        if n1_idx >= 0:
            G[n1_idx, n1_idx] += g
        if n2_idx >= 0:
            G[n2_idx, n2_idx] += g
        if n1_idx >= 0 and n2_idx >= 0:
            G[n1_idx, n2_idx] -= g
            G[n2_idx, n1_idx] -= g

    def _stamp_current_source(self, I, n1_idx, n2_idx, i_value):
        # Current from n1 to n2
        if n1_idx >= 0:
            I[n1_idx] -= i_value
        if n2_idx >= 0:
            I[n2_idx] += i_value
            
    def _stamp_voltage_source(self, G, I, vs_idx, n1_idx, n2_idx, voltage):
        # n1 is positive, n2 is negative
        var_idx = self.num_nodes + vs_idx
        if n1_idx >= 0:
            G[n1_idx, var_idx] += 1.0
            G[var_idx, n1_idx] += 1.0
        if n2_idx >= 0:
            G[n2_idx, var_idx] -= 1.0
            G[var_idx, n2_idx] -= 1.0
        I[var_idx] = voltage

    def _stamp_gmin(self, G):
        # Add a very small conductance (1e-9) to ground from every node to avoid singular matrices
        gmin = 1e-9
        for i in range(self.num_nodes):
            G[i, i] += gmin

    def step(self, t, dt, gate_signals=None):
        if gate_signals is None:
            gate_signals = {}
            
        G = np.zeros((self.num_vars, self.num_vars))
        I = np.zeros(self.num_vars)
        
        self._stamp_gmin(G)
        
        # Build MNA matrices
        for comp in self.components:
            n1 = self.get_node_idx(comp.n1)
            n2 = self.get_node_idx(comp.n2)
            
            if isinstance(comp, Resistor):
                self._stamp_resistor(G, n1, n2, comp.value)
                
            elif isinstance(comp, Capacitor):
                # Backward Euler companion model: R_eq = dt/C, I_eq = C/dt * V(t-dt)
                r_eq = dt / comp.value
                i_eq = (comp.value / dt) * comp.v0
                self._stamp_resistor(G, n1, n2, r_eq)
                self._stamp_current_source(I, n1, n2, -i_eq)
                comp.req = r_eq
                comp.ieq = i_eq
                
            elif isinstance(comp, Inductor):
                # Backward Euler companion model: R_eq = L/dt, I_eq = I(t-dt)
                r_eq = comp.value / dt
                i_eq = comp.i0
                self._stamp_resistor(G, n1, n2, r_eq)
                self._stamp_current_source(I, n1, n2, i_eq)
                comp.req = r_eq
                comp.ieq = i_eq
                
            elif isinstance(comp, Switch):
                # Model as variable resistor
                r_val = comp.get_resistance()
                self._stamp_resistor(G, n1, n2, r_val)
                
        # Stamp voltage sources
        for i, vs in enumerate(self.voltage_sources):
            n1 = self.get_node_idx(vs.n1)
            n2 = self.get_node_idx(vs.n2)
            v_val = vs.get_voltage(t)
            self._stamp_voltage_source(G, I, i, n1, n2, v_val)
            
        # Solve
        try:
            x = np.linalg.solve(G, I)
        except np.linalg.LinAlgError:
            print(f"Singular matrix at t={t}")
            return None
            
        # Update states for next step
        node_voltages = {}
        for node, idx in self.node_map.items():
            node_voltages[node] = x[idx]
        node_voltages['gnd'] = 0.0
        node_voltages['0'] = 0.0
        node_voltages['GND'] = 0.0
        
        branch_currents = {}
        branch_voltages = {}
        branch_powers = {}
        
        # Compute branch currents and update component memories
        for comp in self.components:
            v_n1 = node_voltages.get(comp.n1, 0.0)
            v_n2 = node_voltages.get(comp.n2, 0.0)
            v_diff = v_n1 - v_n2
            branch_voltages[comp.name] = v_diff
            
            if isinstance(comp, Resistor):
                i_b = v_diff / max(comp.value, 1e-12)
                branch_currents[comp.name] = i_b
            elif isinstance(comp, Capacitor):
                i_b = (v_diff / comp.req) - comp.ieq
                branch_currents[comp.name] = i_b
                comp.v0 = v_diff
            elif isinstance(comp, Inductor):
                i_b = (v_diff / comp.req) + comp.ieq
                branch_currents[comp.name] = i_b
                comp.i0 = i_b
            elif isinstance(comp, Switch):
                i_b = v_diff / comp.get_resistance()
                branch_currents[comp.name] = i_b
                gate = gate_signals.get(comp.name, False)
                if isinstance(comp, Diode):
                    comp.update_state(v_diff, i_b)
                elif isinstance(comp, Thyristor):
                    comp.update_state(v_diff, i_b, gate)
                elif isinstance(comp, MOSFET):
                    comp.update_state(v_diff, i_b, gate)
            elif isinstance(comp, VoltageSource):
                vs_idx = self.voltage_sources.index(comp)
                i_b = x[self.num_nodes + vs_idx]
                branch_currents[comp.name] = i_b
            else:
                branch_currents[comp.name] = 0.0
                
            branch_powers[comp.name] = v_diff * branch_currents[comp.name]

        return x, node_voltages, branch_currents, branch_voltages, branch_powers
        
    def run(self, t_end, dt, get_gate_signals=None):
        self.dt = dt
        self.build_maps()
        
        times = np.arange(0, t_end, dt)
        results = {
            'time': times,
            'nodes': {node: np.zeros(len(times)) for node in self.node_map},
            'switches': {comp.name: np.zeros(len(times)) for comp in self.components if isinstance(comp, Switch)},
            'branch_i': {comp.name: np.zeros(len(times)) for comp in self.components},
            'branch_v': {comp.name: np.zeros(len(times)) for comp in self.components},
            'branch_p': {comp.name: np.zeros(len(times)) for comp in self.components}
        }
        
        for i, t in enumerate(times):
            gate_signals = {}
            if get_gate_signals:
                gate_signals = get_gate_signals(t)
                
            res = self.step(t, dt, gate_signals)
            if res is None:
                break
                
            x, node_voltages, b_i, b_v, b_p = res
            
            for node, val in node_voltages.items():
                if node in results['nodes']:
                    results['nodes'][node][i] = val
                    
            for comp in self.components:
                if isinstance(comp, Switch):
                    results['switches'][comp.name][i] = 1.0 if comp.state else 0.0
                results['branch_i'][comp.name][i] = b_i.get(comp.name, 0.0)
                results['branch_v'][comp.name][i] = b_v.get(comp.name, 0.0)
                results['branch_p'][comp.name][i] = b_p.get(comp.name, 0.0)
                    
        return results
