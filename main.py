# main.py
import numpy as np
import matplotlib.pyplot as plt
from core.components import Resistor, VoltageSource, Diode, Inductor
from core.engine import Simulator

def main():
    sim = Simulator()
    
    # Simple Half-Wave Rectifier with RL Load
    # AC Source: 325V peak, 50Hz
    sim.add_component(VoltageSource('V1', 'n1', 'gnd', vtype='ac', amplitude=325, freq=50))
    sim.add_component(Diode('D1', 'n1', 'n2'))
    sim.add_component(Inductor('L1', 'n2', 'n3', value=0.01)) # 10mH
    sim.add_component(Resistor('R1', 'n3', 'gnd', value=10))  # 10 Ohms
    
    print("Running simulation...")
    results = sim.run(t_end=0.06, dt=1e-5)
    print("Simulation complete. Plotting...")
    
    t = results['time']
    v_source = results['nodes']['n1']
    v_load = results['nodes']['n3']
    
    plt.figure(figsize=(10, 6))
    plt.subplot(2, 1, 1)
    plt.plot(t * 1000, v_source, label='Source Voltage')
    plt.plot(t * 1000, results['nodes']['n2'], label='D1 Cathode Voltage')
    plt.plot(t * 1000, v_load, label='Load Voltage (across R)')
    plt.ylabel('Voltage (V)')
    plt.legend()
    plt.grid(True)
    
    plt.subplot(2, 1, 2)
    i_load = v_load / 10.0
    plt.plot(t * 1000, i_load, label='Load Current (A)', color='red')
    plt.xlabel('Time (ms)')
    plt.ylabel('Current (A)')
    plt.legend()
    plt.grid(True)
    
    plt.tight_layout()
    plt.savefig('test_output.png')
    print("Saved test_output.png")

if __name__ == "__main__":
    main()
