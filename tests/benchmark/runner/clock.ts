/**
 * The simulated wall clock every production service is given as `now`.
 *
 * `set()` jumps to a simulated instant; from there time flows at real speed
 * (a request that takes three seconds takes three simulated seconds) and never
 * stands still: two reads are always at least a millisecond apart, so rows
 * written in sequence keep a strict order — exactly as on a real machine.
 */
export class SimulatedClock {
  private baseMs: number;
  private anchorRealMs: number;
  private lastMs = -Infinity;

  constructor(start: Date) {
    this.baseMs = start.getTime();
    this.anchorRealMs = performance.now();
  }

  /** Jump to `at`. Refuses to go backwards: history must stay in order. */
  set(at: Date): void {
    if (at.getTime() <= this.lastMs) {
      throw new Error(`Simulated clock cannot move back from ${new Date(this.lastMs).toISOString()} to ${at.toISOString()}`);
    }
    this.baseMs = at.getTime();
    this.anchorRealMs = performance.now();
  }

  now = (): Date => {
    const flowing = this.baseMs + Math.floor(performance.now() - this.anchorRealMs);
    this.lastMs = Math.max(flowing, this.lastMs + 1);
    return new Date(this.lastMs);
  };

  /** The current simulated instant without advancing the clock. */
  peek(): Date {
    return new Date(Math.max(this.baseMs + Math.floor(performance.now() - this.anchorRealMs), this.lastMs));
  }
}
