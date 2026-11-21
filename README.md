# Sokoban solver — room-decomposed push-optimal A*

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/alawymuhsin/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/alawymuhsin/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

`main.ts` solves a whole set of Sokoban levels (i001–i005) in one run. It
reads every instance under `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt`, creating `/output/<id>/` itself. The input and
output directories come from `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` (defaults `/input` and `/output`). Node 22, no
dependencies, no network, no clock, no randomness — fully deterministic, so
two runs produce byte-identical outputs.

## Why it beats a plain A*

The levels are generated: a 1-wide hallway across the board with 1–4 rooms
off it, each room holding 3–4 boxes and as many goals, opening onto the
hallway through one door. A box pushed through a door into the hallway can
never be pushed back, so every box stays in its room and a level's
push-optimum is the sum of its rooms' optima. A plain move-based A* over
the whole level (the house baseline's shape) searches the product of the
rooms' positions and minimises moves, not pushes — it solves only the
smallest practice level and gives up on the rest.

This solver exploits the structure instead:

1. **Find the hallway and the rooms.** The hallway row is the one the
   player starts on; each room's door is the non-wall square in the row
   beside it, and a room's squares are everything reachable from its door
   without crossing the hallway.
2. **Solve each room push-optimally, on its own.** A push-based A* over
   box configurations: a state is the sorted box squares plus the player's
   reachable region; each action pushes one box one square. The heuristic
   is the minimum-cost matching of boxes to goals by push distance
   (reverse-BFS distances that ignore other boxes, so a lower bound).
   Deadlocks are pruned three ways: boxes pushed onto dead squares (cells
   from which no goal can be reached by pushes), boxes that can never be
   pushed again (walls alone block every direction), and boxes stuck in a
   full 2x2 block of walls and boxes.
3. **Stitch with walks.** The player walks through the hallway from room
   to room (shortest-path BFS with the boxes as obstacles); each room's
   solution starts from the hallway square outside its door.

A plain move-based A* over the whole level is kept only as a fallback for
a level whose rooms cannot be read or solved. Every search is budgeted by
a fixed expansion cap, never by the clock.

## Practice results

On the kit's practice set the solver finds the push-optimum on every
instance — 13, 16, 29, 47 and 60 pushes, exactly the manifest's P\* —
for a practice score of **1,000,000** (the maximum). The house baseline
(plain-astar 1.0.0) scores **200,000** on the same set: it solves only
i001 and leaves i002–i005 unanswered. Total runtime for the 5 instances
is about 0.3 s on one CPU, against the 60 s wall budget; per-room A\*
expansions run 14–60 states, against a 300,000 cap. A second run produces
byte-identical outputs.

## How to run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=../kit/sokoban-solver-01-run-20261121-kit/practice/input \
  MAKEFUN_OUTPUT_DIR=out node main.ts
```

That reads the practice levels and writes `out/<id>/solution.txt` for each.
Node 22.18 or later (Node runs the TypeScript as it is). No dependencies,
no build step. Setting `SOKOBAN_DEBUG=1` prints one line per room solved
(expansions, moves) to stderr; it changes nothing about the outputs.

## Files

- `main.ts` — the solver (entrypoint)
- `README.md` — this file
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=0zkhwx20&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
