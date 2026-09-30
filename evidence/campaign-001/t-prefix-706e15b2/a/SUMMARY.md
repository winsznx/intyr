# campaign-001

Suppliers in these runs are the seeded simulator (SIMULATED). B0 and B1 ran in process; T ran against the deployed Worker's sandbox routes at https://intyr.timjosh507.workers.dev under server-sponsored TestNet sessions, so no USDC moved. The auditor reads the simulator's order list, never an arm's own records. T's declared limits: min_readiness 30, max_price_move_pct 10.

| Arm | Cell | Runs | Complete | Unwound | Inconsistent | CTR | Orphan USD / 100 trips | Duplicate orders | Belief mismatches |
|---|---|---|---|---|---|---|---|---|---|
| T | C0 Healthy control, no faults | 10 | 10 | 0 | 0 | 100% | 0.00 | 0 | 0 |
| T | F1 Flight reprices between quote and payment | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| T | F2 Flight inventory gone at commit | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| T | F3 Hotel refuses the booking after the flight confirmed | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |

| Arm | Runs | CTR | Completion when feasible | Orphan USD / 100 trips | Duplicate orders | Belief mismatches | Unknown beliefs | Mean supplier calls |
|---|---|---|---|---|---|---|---|---|
| T | 40 | 100% | 50% | 0.00 | 0 | 0 | 0 | 3.0 |
