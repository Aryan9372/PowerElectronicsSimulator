# core/parser.py
import json
from .components import Resistor, Capacitor, Inductor, VoltageSource, Diode, Thyristor, MOSFET
from .engine import Simulator

def build_from_json(json_data):
    """
    Constructs a Simulator instance from a JSON dictionary describing the circuit.
    """
    if isinstance(json_data, str):
        data = json.loads(json_data)
    else:
        data = json_data
        
    sim = Simulator()
    
    # Load components
    for comp_data in data.get('components', []):
        ctype = comp_data.get('type')
        cid = comp_data.get('id')
        nodes = comp_data.get('nodes', [])
        
        if ctype == 'Resistor':
            sim.add_component(Resistor(cid, nodes[0], nodes[1], value=comp_data['value']))
        elif ctype == 'Capacitor':
            sim.add_component(Capacitor(cid, nodes[0], nodes[1], value=comp_data['value'], v0=comp_data.get('v0', 0.0)))
        elif ctype == 'Inductor':
            sim.add_component(Inductor(cid, nodes[0], nodes[1], value=comp_data['value'], i0=comp_data.get('i0', 0.0)))
        elif ctype == 'V_AC':
            sim.add_component(VoltageSource(cid, nodes[0], nodes[1], vtype='ac', 
                                            amplitude=comp_data['amplitude'], 
                                            freq=comp_data['freq'], 
                                            phase=comp_data.get('phase', 0.0)))
        elif ctype == 'V_DC':
            sim.add_component(VoltageSource(cid, nodes[0], nodes[1], vtype='dc', value=comp_data['value']))
        elif ctype == 'Diode':
            ron = comp_data.get('ron', 1e-4)
            roff = comp_data.get('roff', 1e6)
            sim.add_component(Diode(cid, nodes[0], nodes[1], ron=ron, roff=roff))
        elif ctype == 'Thyristor':
            ron = comp_data.get('ron', 1e-4)
            roff = comp_data.get('roff', 1e6)
            sim.add_component(Thyristor(cid, nodes[0], nodes[1], ron=ron, roff=roff))
        elif ctype == 'MOSFET':
            ron = comp_data.get('ron', 1e-4)
            roff = comp_data.get('roff', 1e6)
            body_diode = comp_data.get('body_diode', True)
            sim.add_component(MOSFET(cid, nodes[0], nodes[1], ron=ron, roff=roff, body_diode=body_diode))
            
    return sim, data.get('simulation', {})
