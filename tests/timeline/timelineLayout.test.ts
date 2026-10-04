import { describe, it, expect } from 'vitest';
import {
  blockAt,
  blockMode,
  computeDayLayout,
  parseDensity,
  pxPerHourFor,
  CHIP_HEIGHT,
  LABEL_MIN_HEIGHT,
  MIN_MARKER_HEIGHT,
  TIMELINE_DENSITIES,
  type DayLayout,
  type LayoutInput,
} from '../../src/ui/Timeline/timelineLayout';
import { DAY_PX_PER_HOUR, fullDayHeight, timeToPx } from '../../src/ui/Timeline/timelineUtils';
import { DAY, at, denseDay } from '../ui/timelineFixtures';

const s = (id: string, start: string, end: string): LayoutInput => ({ id, startedAt: at(start), endedAt: at(end) });
const layoutOf = (items: LayoutInput[], pxPerHour = DAY_PX_PER_HOUR) => computeDayLayout(items, DAY, pxPerHour);
const get = (layout: DayLayout, id: string) => {
  const block = layout.byId.get(id);
  if (!block) throw new Error(`no block ${id}`);
  return block;
};

/** Every pair of drawn rectangles that share any area. */
function collisions(layout: DayLayout): string[] {
  const hits: string[] = [];
  const eps = 1e-6;
  for (let i = 0; i < layout.blocks.length; i++) {
    for (let j = i + 1; j < layout.blocks.length; j++) {
      const a = layout.blocks[i];
      const b = layout.blocks[j];
      const overlapX = a.left < b.left + b.width - eps && b.left < a.left + a.width - eps;
      const aTop = a.top + a.inset;
      const bTop = b.top + b.inset;
      const overlapY = aTop < bTop + b.height - eps && bTop < aTop + a.height - eps;
      if (overlapX && overlapY) hits.push(`${a.id} x ${b.id}`);
    }
  }
  return hits;
}

describe('computeDayLayout — lanes', () => {
  it('lets activities that do not overlap share one full-width lane', () => {
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '10:00', '11:00'), s('c', '12:00', '13:00')]);
    for (const id of ['a', 'b', 'c']) {
      expect(get(layout, id)).toMatchObject({ lane: 0, laneCount: 1, left: 0, width: 1 });
    }
    expect(layout.maxLanes).toBe(1);
    expect(collisions(layout)).toEqual([]);
  });

  it('puts overlapping activities in different lanes', () => {
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '09:30', '10:30')]);
    expect(get(layout, 'a').lane).not.toBe(get(layout, 'b').lane);
    expect(get(layout, 'a').width).toBeCloseTo(0.5);
    expect(get(layout, 'b').width).toBeCloseTo(0.5);
    expect(collisions(layout)).toEqual([]);
  });

  it('gives a nested activity its own lane', () => {
    const layout = layoutOf([s('outer', '10:00', '12:00'), s('inner', '10:30', '11:15')]);
    expect(get(layout, 'outer').lane).toBe(0);
    expect(get(layout, 'inner').lane).toBe(1);
    expect(collisions(layout)).toEqual([]);
  });

  it('uses three lanes for a three-way overlap', () => {
    const layout = layoutOf([s('a', '10:00', '12:00'), s('b', '10:30', '11:15'), s('c', '10:45', '12:30')]);
    expect(new Set(['a', 'b', 'c'].map((id) => get(layout, id).lane)).size).toBe(3);
    expect(layout.maxLanes).toBe(3);
    expect(collisions(layout)).toEqual([]);
  });

  it('uses ten lanes for a ten-way overlap', () => {
    const items = Array.from({ length: 10 }, (_, i) => s(`x${i}`, `10:${String(i).padStart(2, '0')}`, '12:00'));
    const layout = layoutOf(items);
    expect(new Set(layout.blocks.map((b) => b.lane)).size).toBe(10);
    expect(layout.maxLanes).toBe(10);
    for (const b of layout.blocks) expect(b.width).toBeCloseTo(0.1);
    expect(collisions(layout)).toEqual([]);
  });

  it('never uses more lanes than activities running at once', () => {
    // a and c do not overlap, so c reuses a's lane beside b.
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '09:30', '11:30'), s('c', '10:15', '11:00')]);
    expect(layout.maxLanes).toBe(2);
    expect(get(layout, 'c').lane).toBe(get(layout, 'a').lane);
    expect(collisions(layout)).toEqual([]);
  });

  it('returns to full width once an overlap has ended', () => {
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '09:30', '10:00'), s('c', '10:00', '11:00')]);
    expect(get(layout, 'a').laneCount).toBe(2);
    expect(get(layout, 'c')).toMatchObject({ lane: 0, laneCount: 1, width: 1 });
  });

  it('widens a block over lanes that are free for its whole extent', () => {
    // b and c overlap a; d overlaps only c's lane-mate a... d sits beside a with nothing to its right.
    const layout = layoutOf([
      s('a', '09:00', '12:00'),
      s('b', '09:10', '10:00'),
      s('c', '09:20', '10:00'),
      s('d', '10:30', '11:30'),
    ]);
    expect(layout.maxLanes).toBe(3);
    expect(get(layout, 'd').lane).toBe(1);
    expect(get(layout, 'd').laneSpan).toBe(2);
    expect(get(layout, 'd').width).toBeCloseTo(2 / 3);
    expect(collisions(layout)).toEqual([]);
  });

  it('is deterministic and independent of input order', () => {
    const items = denseDay();
    const first = layoutOf(items);
    const again = layoutOf(items);
    const reversed = layoutOf([...items].reverse());
    const shuffled = layoutOf([...items].sort((a, b) => (a.title < b.title ? -1 : 1)));
    expect(again.blocks).toEqual(first.blocks);
    expect(reversed.blocks).toEqual(first.blocks);
    expect(shuffled.blocks).toEqual(first.blocks);
  });

  it('orders ties by start, then end, then id', () => {
    const layout = layoutOf([s('b', '09:00', '10:00'), s('c', '09:00', '09:30'), s('a', '09:00', '10:00')]);
    expect(layout.blocks.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps activities with identical start times apart', () => {
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '09:00', '09:30'), s('c', '09:00', '09:45'), s('d', '09:00', '09:01')]);
    expect(new Set(layout.blocks.map((b) => b.lane)).size).toBe(4);
    expect(collisions(layout)).toEqual([]);
    for (const b of layout.blocks) expect(b.width).toBeGreaterThan(0.1);
  });
});

describe('computeDayLayout — the time axis stays exact', () => {
  it.each(TIMELINE_DENSITIES)('places start and duration exactly at %s density', (density) => {
    const pxPerHour = pxPerHourFor(density);
    const items = denseDay();
    const layout = layoutOf(items, pxPerHour);
    for (const item of items) {
      const block = get(layout, item.id);
      const top = timeToPx(DAY, new Date(item.startedAt), pxPerHour);
      const bottom = timeToPx(DAY, new Date(item.endedAt), pxPerHour);
      expect(block.top).toBeCloseTo(top, 6);
      expect(block.trueHeight).toBeCloseTo(Math.max(0, bottom - top), 6);
      // The drawn box covers the real extent (less the few px given to a preceding sliver)
      // and never ends before the activity does.
      expect(block.inset).toBeGreaterThanOrEqual(0);
      expect(block.inset).toBeLessThanOrEqual(MIN_MARKER_HEIGHT + 1e-9);
      expect(block.inset + block.height).toBeGreaterThanOrEqual(block.trueHeight - 1e-9);
    }
  });

  it('keeps gaps as gaps and overlaps as overlaps', () => {
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '10:30', '11:30'), s('c', '11:00', '12:00')]);
    const a = get(layout, 'a');
    const b = get(layout, 'b');
    const c = get(layout, 'c');
    expect(b.top - (a.top + a.trueHeight)).toBeCloseTo(DAY_PX_PER_HOUR / 2); // 30 empty minutes
    expect(b.top + b.trueHeight - c.top).toBeCloseTo(DAY_PX_PER_HOUR / 2); // 30 shared minutes
    expect(a.height).toBe(a.trueHeight);
  });

  it('scales uniformly with density', () => {
    const items = [s('a', '09:00', '10:00'), s('b', '13:15', '14:45')];
    const base = layoutOf(items, pxPerHourFor('compact'));
    const zoomed = layoutOf(items, pxPerHourFor('detailed'));
    const factor = pxPerHourFor('detailed') / pxPerHourFor('compact');
    for (const id of ['a', 'b']) {
      expect(get(zoomed, id).top).toBeCloseTo(get(base, id).top * factor);
      expect(get(zoomed, id).trueHeight).toBeCloseTo(get(base, id).trueHeight * factor);
    }
  });

  it('never moves a block sideways out of the content area', () => {
    for (const density of TIMELINE_DENSITIES) {
      for (const b of layoutOf(denseDay(), pxPerHourFor(density)).blocks) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.left + b.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(b.width).toBeGreaterThan(0);
      }
    }
  });
});

describe('computeDayLayout — short activities', () => {
  it('draws a short activity compactly, not as a card', () => {
    // Four minutes inside a busy stretch: a sliver, with the next block untouched.
    const layout = layoutOf([s('short', '10:42', '10:46'), s('next', '10:46', '12:00')]);
    const short = get(layout, 'short');
    expect(short.trueHeight).toBeCloseTo(4.8);
    expect(short.height).toBeCloseTo(4.8);
    expect(blockMode(short.height)).toBe('marker');
    expect(get(layout, 'next')).toMatchObject({ lane: 0, width: 1 });
    expect(collisions(layout)).toEqual([]);
  });

  it('never draws a short activity taller than one labelled line', () => {
    for (const density of TIMELINE_DENSITIES) {
      const pxPerHour = pxPerHourFor(density);
      for (const b of layoutOf(denseDay(), pxPerHour).blocks) {
        expect(b.height).toBeLessThanOrEqual(Math.max(b.trueHeight, CHIP_HEIGHT) + 1e-9);
      }
    }
  });

  it('gives an isolated short activity a labelled line', () => {
    const layout = layoutOf([s('alone', '10:00', '10:02')]);
    const alone = get(layout, 'alone');
    expect(alone.trueHeight).toBeCloseTo(2.4);
    expect(alone.height).toBe(CHIP_HEIGHT);
    expect(blockMode(alone.height)).toBe('line');
  });

  it('grows a label only into free space, never into the next activity', () => {
    // 10 minutes of room below: enough for a (shorter) labelled line, not the full chip.
    const layout = layoutOf([s('short', '10:00', '10:01'), s('next', '10:12', '11:00')]);
    const short = get(layout, 'short');
    expect(short.height).toBeCloseTo(14.4);
    expect(short.top + short.height).toBeLessThanOrEqual(get(layout, 'next').top + 1e-9);
    expect(collisions(layout)).toEqual([]);
  });

  it('keeps a long block prominent beside a one-second interruption', () => {
    const layout = layoutOf([s('long', '15:00', '17:00'), s('blip', '15:30:00', '15:30:01')]);
    const long = get(layout, 'long');
    const blip = get(layout, 'blip');
    expect(long.left).toBe(0);
    expect(long.width).toBeGreaterThan(0.7);
    expect(blip.left).toBeCloseTo(long.width);
    expect(blip.width).toBeLessThan(0.3);
    // The interruption has room beside the block, so it is labelled.
    expect(blockMode(blip.height)).toBe('line');
    expect(collisions(layout)).toEqual([]);
  });

  it('stacks an activity under the sliver it follows instead of squeezing it sideways', () => {
    // Sequential, not simultaneous: one lane. The long block gives the
    // one-second sliver its few pixels and stays full width.
    const layout = layoutOf([s('blip', '09:00:00', '09:00:01'), s('long', '09:00:01', '11:00')]);
    const blip = get(layout, 'blip');
    const long = get(layout, 'long');
    expect(blip).toMatchObject({ lane: 0, laneCount: 1, left: 0, width: 1 });
    expect(long).toMatchObject({ lane: 0, laneCount: 1, left: 0, width: 1 });
    expect(blip.height).toBe(MIN_MARKER_HEIGHT);
    expect(long.inset).toBeGreaterThan(0);
    expect(long.inset).toBeLessThanOrEqual(MIN_MARKER_HEIGHT);
    // Its start time is still exact, and its box still ends exactly at its end.
    expect(long.top).toBeCloseTo(timeToPx(DAY, new Date(at('09:00:01'))));
    expect(long.top + long.inset + long.height).toBeCloseTo(timeToPx(DAY, new Date(at('11:00'))));
    expect(collisions(layout)).toEqual([]);
  });

  it('does not trim a block that really overlaps what came before', () => {
    const layout = layoutOf([s('a', '09:00', '10:00'), s('b', '09:59', '11:00')]);
    expect(get(layout, 'b').inset).toBe(0);
    expect(get(layout, 'b').lane).toBe(1);
  });

  it('does not trim a block too short to give pixels away', () => {
    // Two slivers in a row: neither can absorb the other, so they sit side by side.
    const layout = layoutOf([s('x', '09:00:00', '09:00:01'), s('y', '09:00:01', '09:02:00')]);
    expect(get(layout, 'y').inset).toBe(0);
    expect(get(layout, 'x').lane).not.toBe(get(layout, 'y').lane);
    expect(collisions(layout)).toEqual([]);
  });

  it('handles interruptions inside a long activity', () => {
    const layout = layoutOf([
      s('research', '15:00', '17:00'),
      s('video', '15:30', '15:45'),
      s('chat', '16:00', '16:05'),
    ]);
    expect(layout.byId.size).toBe(3);
    expect(get(layout, 'research').lane).toBe(0);
    expect(get(layout, 'video').lane).toBe(1);
    expect(get(layout, 'chat').lane).toBe(1);
    expect(collisions(layout)).toEqual([]);
  });

  it('handles zero-length, inverted and sub-pixel ranges safely', () => {
    const layout = layoutOf([
      s('zero', '10:00:00', '10:00:00'),
      s('inverted', '11:00:00', '10:02:00'),
      s('second', '12:00:00', '12:00:01'),
    ]);
    for (const id of ['zero', 'inverted', 'second']) {
      const b = get(layout, id);
      expect(Number.isFinite(b.top)).toBe(true);
      expect(b.trueHeight).toBeGreaterThanOrEqual(0);
      expect(b.height).toBeGreaterThanOrEqual(MIN_MARKER_HEIGHT);
      expect(b.width).toBeGreaterThan(0);
    }
    expect(get(layout, 'inverted').trueHeight).toBe(0);
    expect(get(layout, 'inverted').top).toBeCloseTo(11 * DAY_PX_PER_HOUR);
    expect(collisions(layout)).toEqual([]);
  });

  it('skips an activity without a readable start instead of throwing', () => {
    const layout = computeDayLayout(
      [{ id: 'bad', startedAt: 'not a date', endedAt: 'nor this' }, s('ok', '09:00', '10:00')],
      DAY,
    );
    expect(layout.blocks.map((b) => b.id)).toEqual(['ok']);
  });

  it('lays out an empty day', () => {
    const layout = layoutOf([]);
    expect(layout.blocks).toEqual([]);
    expect(layout.maxLanes).toBe(0);
  });
});

describe('computeDayLayout — dense day', () => {
  it.each(TIMELINE_DENSITIES)('has no collisions and loses no activity at %s density', (density) => {
    const items = denseDay();
    const layout = layoutOf(items, pxPerHourFor(density));
    expect(layout.blocks).toHaveLength(items.length);
    expect(new Set(layout.blocks.map((b) => b.id))).toEqual(new Set(items.map((i) => i.id)));
    expect(collisions(layout)).toEqual([]);
  });

  it('keeps the long blocks of a dense day wide', () => {
    for (const density of TIMELINE_DENSITIES) {
      const pxPerHour = pxPerHourFor(density);
      const items = denseDay();
      const layout = layoutOf(items, pxPerHour);
      for (const item of items.filter((i) => i.duration >= 30 * 60_000)) {
        expect(get(layout, item.id).width).toBeGreaterThan(0.7);
      }
      // Nothing overlaps these two in clock time: they are full width.
      expect(get(layout, 'd12').width).toBe(1); // follows a 79-second activity
      expect(get(layout, 'd24').width).toBe(1); // follows the burst
    }
  });

  it('labels more of the short activities as density grows', () => {
    const labelled = (density: (typeof TIMELINE_DENSITIES)[number]) =>
      layoutOf(denseDay(), pxPerHourFor(density)).blocks.filter((b) => blockMode(b.height) !== 'marker').length;
    expect(labelled('normal')).toBeGreaterThan(labelled('compact'));
    expect(labelled('detailed')).toBeGreaterThan(labelled('normal'));
    // At full detail every activity of three minutes or more carries its title.
    const detailed = layoutOf(denseDay(), pxPerHourFor('detailed'));
    for (const item of denseDay().filter((i) => i.duration >= 3 * 60_000)) {
      expect(blockMode(get(detailed, item.id).height)).not.toBe('marker');
    }
  });

  it('stays collision-free for a hundred one-minute activities in a row', () => {
    const items = Array.from({ length: 100 }, (_, i) => {
      const start = new Date(2026, 9, 4, 9, i);
      const end = new Date(2026, 9, 4, 9, i + 1);
      return { id: `m${String(i).padStart(3, '0')}`, startedAt: start, endedAt: end };
    });
    for (const density of TIMELINE_DENSITIES) {
      const layout = layoutOf(items, pxPerHourFor(density));
      expect(layout.blocks).toHaveLength(100);
      expect(collisions(layout)).toEqual([]);
    }
  });

  it('stays inside a scrollable day', () => {
    for (const density of TIMELINE_DENSITIES) {
      const pxPerHour = pxPerHourFor(density);
      const dayHeight = fullDayHeight(pxPerHour);
      expect(dayHeight).toBe(24 * pxPerHour);
      for (const b of layoutOf(denseDay(), pxPerHour).blocks) {
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.top + b.trueHeight).toBeLessThanOrEqual(dayHeight);
      }
    }
  });
});

describe('computeDayLayout — sparse day', () => {
  it('draws a sparse day as plain full-width blocks at their real size', () => {
    const layout = layoutOf([s('a', '09:00', '10:30'), s('b', '11:00', '12:00'), s('c', '14:00', '16:00')], pxPerHourFor('normal'));
    for (const b of layout.blocks) {
      expect(b).toMatchObject({ lane: 0, laneSpan: 1, laneCount: 1, left: 0, width: 1 });
      expect(b.height).toBe(b.trueHeight);
      expect(blockMode(b.height)).toBe('full');
    }
  });
});

describe('blockAt — unambiguous hit areas', () => {
  it.each(TIMELINE_DENSITIES)('resolves the centre of every block to that block at %s density', (density) => {
    const layout = layoutOf(denseDay(), pxPerHourFor(density));
    for (const b of layout.blocks) {
      const hit = blockAt(layout, b.left + b.width / 2, b.top + b.inset + b.height / 2);
      expect(hit?.id).toBe(b.id);
    }
  });

  it('distinguishes overlapping activities and finds nothing in a gap', () => {
    const layout = layoutOf([s('outer', '10:00', '12:00'), s('inner', '10:30', '11:15')]);
    const y = 10.75 * DAY_PX_PER_HOUR;
    expect(blockAt(layout, 0.25, y)?.id).toBe('outer');
    expect(blockAt(layout, 0.75, y)?.id).toBe('inner');
    expect(blockAt(layout, 0.75, 11.75 * DAY_PX_PER_HOUR)).toBeNull();
    expect(blockAt(layout, 0.5, 13 * DAY_PX_PER_HOUR)).toBeNull();
  });
});

describe('blockMode / density', () => {
  it('shows more as a block gets taller', () => {
    expect(blockMode(MIN_MARKER_HEIGHT)).toBe('marker');
    expect(blockMode(LABEL_MIN_HEIGHT - 0.1)).toBe('marker');
    expect(blockMode(LABEL_MIN_HEIGHT)).toBe('line');
    expect(blockMode(CHIP_HEIGHT)).toBe('line');
    expect(blockMode(50)).toBe('compact');
    expect(blockMode(72)).toBe('full');
  });

  it('exposes three uniform scales and a safe default', () => {
    expect(TIMELINE_DENSITIES).toEqual(['compact', 'normal', 'detailed']);
    expect(pxPerHourFor('compact')).toBe(DAY_PX_PER_HOUR);
    expect(pxPerHourFor('normal')).toBeGreaterThan(pxPerHourFor('compact'));
    expect(pxPerHourFor('detailed')).toBeGreaterThan(pxPerHourFor('normal'));
    expect(parseDensity('detailed')).toBe('detailed');
    expect(parseDensity('huge')).toBe('normal');
    expect(parseDensity(null)).toBe('normal');
  });
});
