// Web Worker entry: the whole simulation (Rapier + drone physics + flight controllers) off the main thread.
import { serveSim, type Port } from '../sim/serve';

serveSim(self as unknown as Port);
