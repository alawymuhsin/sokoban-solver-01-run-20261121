// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The levels are generated, and that structure is the whole game: a 1-wide
// hallway across the board with 1-4 rooms off it, each room holding 3-4 boxes
// and as many goals, opening onto the hallway through one door. A box pushed
// through a door into the hallway can never be pushed back, so every box
// stays in its room and the level's push-optimum is the sum of its rooms'
// optima. This solver therefore:
//
//   1. finds the hallway row and each room's door,
//   2. solves each room push-optimally on its own with a push-based A*
//      (state = sorted box positions + the player's reachable region;
//      heuristic = minimum-cost matching of boxes to goals by push
//      distance; prunes dead squares, frozen boxes and boxes that can
//      never reach a goal),
//   3. stitches the room solutions with player walks through the hallway.
//
// A plain move-based A* (the house baseline's shape) is kept only as a
// fallback for a level whose rooms cannot be read or solved. Everything is
// budgeted by fixed work caps, never by the clock, and the search is fully
// deterministic: fixed direction orders and heap tie-breaks, no randomness,
// no time reads, so two runs produce byte-identical outputs.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = process.env.SOKOBAN_DEBUG === '1';

// up, down, left, right — fixed order everywhere, so every search is deterministic.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

function at(w: number, x: number, y: number): number {
  return y * w + x;
}

// Shortest player walk from `from` to `to` over floor cells, treating
// `boxSet` as obstacles. Fixed direction order: the same walk every run.
function walkPath(
  w: number,
  h: number,
  wall: Uint8Array,
  boxSet: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-2);
  const prevDir = new Int8Array(w * h).fill(-1);
  const queue = [from];
  prev[from] = -1;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = at(w, nx, ny);
      if (wall[n] || boxSet[n] || prev[n] !== -2) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) {
          s = LETTER[prevDir[cur]!] + s;
          cur = prev[cur]!;
        }
        return s;
      }
      queue.push(n);
    }
  }
  return null;
}

// The squares the player reaches from `from` around walls and boxes, as a
// mask, plus the smallest square of the region (its canonical name: two
// player positions in one region are the same state).
function regionOf(
  w: number,
  h: number,
  floor: Uint8Array,
  boxSet: Uint8Array,
  from: number,
): { mask: Uint8Array; min: number } {
  const mask = new Uint8Array(w * h);
  const queue = [from];
  mask[from] = 1;
  let min = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = at(w, nx, ny);
      if (!floor[n] || boxSet[n] || mask[n]) continue;
      mask[n] = 1;
      if (n < min) min = n;
      queue.push(n);
    }
  }
  return { mask, min };
}

// Reverse push distances: for each goal, the fewest pushes a box needs to
// reach it from every square, ignoring other boxes and the player's exact
// spot (both only ever help, so this is a lower bound). A square is live
// when it can reach some goal; the rest are dead squares a box must never
// be pushed onto. The reverse step: from a square x that reaches a goal,
// a square y = x - d reaches it too when the forward push y -> x is legal
// (the player can stand at y - d = x - 2d and the destination x is floor).
function pushDistances(
  w: number,
  h: number,
  floor: Uint8Array,
  goals: number[],
): { dist: Int32Array[]; live: Uint8Array } {
  const dist: Int32Array[] = [];
  const live = new Uint8Array(w * h);
  for (const g of goals) {
    const d = new Int32Array(w * h).fill(-1);
    d[g] = 0;
    live[g] = 1;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      const xx = x % w;
      const xy = Math.floor(x / w);
      for (let dir = 0; dir < 4; dir++) {
        const yx = xx - DX[dir];
        const yy = xy - DY[dir];
        const zx = xx - 2 * DX[dir];
        const zy = xy - 2 * DY[dir];
        if (yx < 0 || yx >= w || yy < 0 || yy >= h) continue;
        if (zx < 0 || zx >= w || zy < 0 || zy >= h) continue;
        const y = at(w, yx, yy);
        if (!floor[y] || d[y] >= 0) continue;
        if (!floor[at(w, zx, zy)]) continue;
        d[y] = d[x]! + 1;
        live[y] = 1;
        queue.push(y);
      }
    }
    dist.push(d);
  }
  return { dist, live };
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

// Minimum-cost matching of boxes to goals by push distance (a lower bound
// on the pushes still needed: every push moves one box one square).
function heuristic(
  boxes: number[],
  dist: Int32Array[],
  perms: number[][],
): number {
  let best = Infinity;
  for (const p of perms) {
    let s = 0;
    for (let j = 0; j < boxes.length; j++) {
      const d = dist[p[j]!]![boxes[j]!]!;
      if (d < 0) {
        s = Infinity;
        break;
      }
      s += d;
    }
    if (s < best) best = s;
  }
  return best;
}

interface RoomProblem {
  w: number;
  h: number;
  floor: Uint8Array; // the room's squares, its door and the hallway square outside it
  goals: number[];
  boxes: number[];
  start: number; // the hallway square outside the door
}

const ROOM_EXPANSION_CAP = 300_000;

// Push-optimal A* over one room. A state is the sorted box squares plus the
// player's reachable region; each action pushes one box one square.
function solveRoom(prob: RoomProblem): { moves: string; expansions: number } | null {
  const { w, h, floor, goals, boxes, start } = prob;
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;
  const { dist, live } = pushDistances(w, h, floor, goals);
  const perms = permutations(boxes.length);
  const wall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) wall[i] = floor[i] ? 0 : 1;

  // Whether box q could ever be pushed again, walls alone considered: some
  // direction with floor ahead and floor behind. Other boxes may move away,
  // and the player may walk around later, so only walls count here — a box
  // the player merely cannot reach behind right now is not frozen.
  const canEverPush = (q: number): boolean => {
    const qx = q % w;
    const qy = Math.floor(q / w);
    for (let d = 0; d < 4; d++) {
      const dx = DX[d]!;
      const dy = DY[d]!;
      const destX = qx + dx;
      const destY = qy + dy;
      const behX = qx - dx;
      const behY = qy - dy;
      if (destX < 0 || destX >= w || destY < 0 || destY >= h) continue;
      if (behX < 0 || behX >= w || behY < 0 || behY >= h) continue;
      if (floor[at(w, destX, destY)] && floor[at(w, behX, behY)]) return true;
    }
    return false;
  };

  // Whether q sits in a 2x2 block of walls and boxes: nothing in such a
  // block can ever be pushed (every push out needs the player to stand on
  // a blocked square of the block, every push inside lands on one).
  const inFullBlock = (q: number, boxSet: Uint8Array): boolean => {
    const qx = q % w;
    const qy = Math.floor(q / w);
    const blocked = (x: number, y: number): boolean => {
      if (x < 0 || x >= w || y < 0 || y >= h) return true;
      const c = at(w, x, y);
      return !floor[c] || !!boxSet[c];
    };
    for (const [ox, oy] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ]) {
      if (
        blocked(qx + ox, qy + oy) &&
        blocked(qx + ox + 1, qy + oy) &&
        blocked(qx + ox, qy + oy + 1) &&
        blocked(qx + ox + 1, qy + oy + 1)
      ) {
        return true;
      }
    }
    return false;
  };

  const keyOf = (bs: number[], regionMin: number): string => bs.join(',') + '|' + regionMin;

  const sp: number[] = [start];
  const sb: number[][] = [boxes.slice()];
  const sg: number[] = [0];
  const sparent: number[] = [-1];
  const spushBox: number[] = [-1];
  const spushDir: number[] = [-1];
  const skey: string[] = [];
  const best = new Map<string, number>();
  const startSet = new Uint8Array(w * h);
  for (const b of boxes) startSet[b] = 1;
  const startRegion = regionOf(w, h, floor, startSet, start);
  skey.push(keyOf(boxes, startRegion.min));
  best.set(skey[0]!, 0);

  // Heap of [f, -g, -boxesOnGoals, state]: lowest f first, deeper (larger
  // g) first on ties, and among those the state with more boxes already on
  // goals — that last tie-break steers the search toward finished rooms
  // instead of wandering through equal-cost half-done states.
  const heap: [number, number, number, number][] = [];
  const less = (
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): boolean =>
    a[0] < b[0] ||
    (a[0] === b[0] &&
      (a[1] < b[1] ||
        (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[3] < b[3])))));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(boxes, dist, perms);
  if (!isFinite(h0)) return null;
  heapPush([h0, 0, -boxes.filter((b) => goalSet[b]).length, 0]);
  let expansions = 0;
  while (heap.length > 0 && expansions < ROOM_EXPANSION_CAP) {
    const [, , , s] = heapPop();
    if (best.get(skey[s]!) !== s) continue;
    const bs = sb[s]!;
    if (bs.every((b) => goalSet[b])) {
      // Reconstruct: for each push, the player's walk to the pushing square
      // (recomputed in the parent's state, deterministic BFS) plus the push.
      const steps: { box: number; dir: number; parent: number }[] = [];
      for (let t = s; t > 0; t = sparent[t]!) {
        steps.push({ box: spushBox[t]!, dir: spushDir[t]!, parent: sparent[t]! });
      }
      steps.reverse();
      let moves = '';
      for (const st of steps) {
        const pBoxes = sb[st.parent]!;
        const pSet = new Uint8Array(w * h);
        for (const q of pBoxes) pSet[q] = 1;
        const from = sp[st.parent]!;
        const pushPos = st.box - DY[st.dir]! * w - DX[st.dir]!;
        const walk = walkPath(w, h, wall, pSet, from, pushPos);
        if (walk === null) return null;
        moves += walk + LETTER[st.dir]!;
      }
      return { moves, expansions };
    }
    expansions++;
    const p = sp[s]!;
    const boxSet = new Uint8Array(w * h);
    for (const b of bs) boxSet[b] = 1;
    const region = regionOf(w, h, floor, boxSet, p);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const destX = bx + dx;
        const destY = by + dy;
        const behX = bx - dx;
        const behY = by - dy;
        if (destX < 0 || destX >= w || destY < 0 || destY >= h) continue;
        if (behX < 0 || behX >= w || behY < 0 || behY >= h) continue;
        const dest = at(w, destX, destY);
        if (!floor[dest] || boxSet[dest]) continue;
        if (!region.mask[at(w, behX, behY)]) continue;
        // A box on a dead square can never reach a goal: prune.
        if (!live[dest]) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Uint8Array(w * h);
        for (const q of nb) nbSet[q] = 1;
        const childRegion = regionOf(w, h, floor, nbSet, b);
        // A box off its goal that can never be pushed again, or one stuck
        // in a full 2x2 block of walls and boxes, deadlocks the room: prune.
        let frozen = false;
        for (const q of nb) {
          if (goalSet[q]) continue;
          if (!canEverPush(q) || inFullBlock(q, nbSet)) {
            frozen = true;
            break;
          }
        }
        if (frozen) continue;
        const hh = heuristic(nb, dist, perms);
        if (!isFinite(hh)) continue;
        const k = keyOf(nb, childRegion.min);
        const seen = best.get(k);
        const ng = sg[s]! + 1;
        if (seen !== undefined && sg[seen]! <= ng) continue;
        const t = sp.length;
        sp.push(b);
        sb.push(nb);
        sg.push(ng);
        sparent.push(s);
        spushBox.push(b);
        spushDir.push(d);
        skey.push(k);
        best.set(k, t);
        heapPush([ng + hh, -ng, -nb.filter((q) => goalSet[q]).length, t]);
      }
    }
  }
  return null;
}

interface DetectedRoom {
  door: number;
  hall: number; // the hallway square outside the door
  cells: number[];
  boxes: number[];
  goals: number[];
  side: number; // -1 above the hallway, +1 below it
}

// Find the hallway row (the one row of floor from x=1 to x=w-2) and each
// room's door (a non-wall square in the row beside the hallway). A room's
// squares are everything reachable from its door without crossing the
// hallway. Returns null when the level does not read as hallway + rooms.
function detectRooms(level: Level): { hallRow: number; rooms: DetectedRoom[] } | null {
  const { w, h, wall } = level;
  // The hallway row is the one the player starts on: the generator puts the
  // player on a hallway square. (A room row can happen to be floor right
  // across too, so "first row spanning the board" is not the hallway.)
  const spans = (y: number): boolean => {
    for (let x = 1; x <= w - 2; x++) if (wall[at(w, x, y)]) return false;
    return true;
  };
  let hallRow = Math.floor(level.player / w);
  if (!spans(hallRow)) {
    hallRow = -1;
    for (let y = 0; y < h; y++) {
      if (spans(y)) {
        hallRow = y;
        break;
      }
    }
  }
  if (hallRow < 0) return null;
  const rooms: DetectedRoom[] = [];
  for (const side of [-1, 1]) {
    const doorRow = hallRow + side;
    if (doorRow < 0 || doorRow >= h) continue;
    for (let x = 1; x <= w - 2; x++) {
      const door = at(w, x, doorRow);
      if (wall[door]) continue;
      const seen = new Uint8Array(w * h);
      const cells: number[] = [];
      const queue = [door];
      seen[door] = 1;
      for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi]!;
        cells.push(c);
        const cx = c % w;
        const cy = Math.floor(c / w);
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d];
          const ny = cy + DY[d];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (side === -1 && ny >= hallRow) continue;
          if (side === 1 && ny <= hallRow) continue;
          const n = at(w, nx, ny);
          if (seen[n] || wall[n]) continue;
          seen[n] = 1;
          queue.push(n);
        }
      }
      const boxes = level.boxes.filter((b) => seen[b]);
      const goals = level.goals.filter((g) => seen[g]);
      if (boxes.length === 0) continue;
      // Two doors into one room would report it twice: keep the first.
      if (rooms.some((r) => r.boxes.length === boxes.length && r.boxes.every((b, i) => b === boxes[i]))) continue;
      rooms.push({ door, hall: at(w, x, hallRow), cells, boxes, goals, side });
    }
  }
  const accounted = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (accounted !== level.boxes.length) return null;
  rooms.sort((a, b) => a.side - b.side || a.door - b.door);
  return { hallRow, rooms };
}

// Replay moves on the full level, updating `boxSet` and returning the
// player's final square (null when a move is illegal — never expected).
function applyMoves(
  level: Level,
  boxSet: Uint8Array,
  player: number,
  moves: string,
): { player: number } | null {
  let p = player;
  for (const ch of moves) {
    const d = LETTER.indexOf(ch);
    if (d < 0) return null;
    const next = p + DY[d]! * level.w + DX[d]!;
    if (level.wall[next]) return null;
    if (boxSet[next]) {
      const beyond = next + DY[d]! * level.w + DX[d]!;
      if (level.wall[beyond] || boxSet[beyond]) return null;
      boxSet[next] = 0;
      boxSet[beyond] = 1;
    }
    p = next;
  }
  return { player: p };
}

const WHOLE_EXPANSION_CAP = 200_000;

// Fallback: a plain move-based A* over the whole level (the house baseline's
// shape), minimising moves. Only used when a level's rooms cannot be read or
// a room cannot be solved; an empty answer when it gives up too.
function solveWhole(level: Level): string {
  const { w, h, wall, goals, boxes, player } = level;
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;
  const manhattan = (b: number): number => {
    let m = Infinity;
    for (const g of goals) {
      const d = Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w));
      if (d < m) m = d;
    }
    return m;
  };
  const est = (bs: number[]): number => bs.reduce((a, b) => a + manhattan(b), 0);
  const keyOf = (p: number, bs: number[]): string => p + '|' + bs.join(',');
  const sp: number[] = [player];
  const sb: number[][] = [boxes.slice()];
  const sg: number[] = [0];
  const sparent: number[] = [-1];
  const sstep: string[] = [''];
  const best = new Map<string, number>([[keyOf(player, boxes), 0]]);
  const heap: [number, number, number][] = [];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([est(boxes), 0, 0]);
  let expansions = 0;
  while (heap.length > 0 && expansions < WHOLE_EXPANSION_CAP) {
    const [, , s] = heapPop();
    const bs = sb[s]!;
    const p = sp[s]!;
    if (best.get(keyOf(p, bs)) !== s) continue;
    if (bs.every((b) => goalSet[b])) {
      let moves = '';
      for (let t = s; t > 0; t = sparent[t]!) moves = sstep[t]! + moves;
      return moves;
    }
    expansions++;
    const px = p % w;
    const py = Math.floor(p / w);
    for (let d = 0; d < 4; d++) {
      const nx = px + DX[d]!;
      const ny = py + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const q = at(w, nx, ny);
      if (wall[q]) continue;
      let nb = bs;
      const atBox = bs.indexOf(q);
      if (atBox >= 0) {
        const bx = nx + DX[d]!;
        const by = ny + DY[d]!;
        if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
        const beyond = at(w, bx, by);
        if (wall[beyond] || bs.includes(beyond)) continue;
        nb = bs.slice();
        nb[atBox] = beyond;
        nb.sort((a, b2) => a - b2);
      }
      const k = keyOf(q, nb);
      const seen = best.get(k);
      if (seen !== undefined && sg[seen]! <= sg[s]! + 1) continue;
      const t = sp.length;
      sp.push(q);
      sb.push(nb);
      sg.push(sg[s]! + 1);
      sparent.push(s);
      sstep.push(LETTER[d]!);
      best.set(k, t);
      heapPush([sg[s]! + 1 + est(nb), -(sg[s]! + 1), t]);
    }
  }
  return '';
}

function solveLevel(text: string): string {
  const level = parse(text);
  const det = detectRooms(level);
  if (det !== null) {
    let moves = '';
    let player = level.player;
    const boxSet = new Uint8Array(level.w * level.h);
    for (const b of level.boxes) boxSet[b] = 1;
    let ok = true;
    for (const room of det.rooms) {
      const walk = walkPath(level.w, level.h, level.wall, boxSet, player, room.hall);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      player = room.hall;
      const floor = new Uint8Array(level.w * level.h);
      for (const c of room.cells) floor[c] = 1;
      floor[room.hall] = 1;
      const res = solveRoom({
        w: level.w,
        h: level.h,
        floor,
        goals: room.goals,
        boxes: room.boxes,
        start: room.hall,
      });
      if (res === null) {
        ok = false;
        break;
      }
      if (DEBUG) {
        console.error(
          `room door=${room.door} boxes=${room.boxes.length} expansions=${res.expansions} moves=${res.moves.length}`,
        );
      }
      const sim = applyMoves(level, boxSet, player, res.moves);
      if (sim === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      player = sim.player;
    }
    if (ok) return moves;
  }
  return solveWhole(level);
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    if (!statSync(join(I, id)).isDirectory()) continue;
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), moves + '\n');
}
