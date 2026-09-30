# campaign-001

Suppliers in these runs are the seeded simulator (SIMULATED). The auditor reads the simulator's order list, never an arm's own records.

| Arm | Cell | Runs | Complete | Unwound | Inconsistent | CTR | Orphan USD / 100 trips | Duplicate orders | Belief mismatches |
|---|---|---|---|---|---|---|---|---|---|
| B0 | C0 Healthy control, no faults | 10 | 10 | 0 | 0 | 100% | 0.00 | 0 | 0 |
| B0 | F1 Flight reprices between quote and payment | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B0 | F2 Flight inventory gone at commit | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B0 | F3 Hotel refuses the booking after the flight confirmed | 10 | 0 | 0 | 10 | 0% | 30336.50 | 0 | 0 |
| B0 | F4 Flight accepted asynchronously, then fails | 10 | 0 | 0 | 10 | 0% | 19208.20 | 0 | 10 |
| B0 | F5 Flight booked but the response is lost | 10 | 0 | 0 | 10 | 0% | 68415.80 | 10 | 0 |
| B0 | F6 Hotel times out and nothing was booked | 10 | 0 | 0 | 10 | 0% | 32387.70 | 0 | 0 |
| B0 | F7 Hotel says confirmed but no booking exists | 10 | 0 | 0 | 10 | 0% | 31025.40 | 0 | 10 |
| B0 | F8 Flight response lost, supplier duplicates on retry | 10 | 0 | 0 | 10 | 0% | 62598.40 | 10 | 0 |
| B0 | F9 Non-refundable flight, hotel refuses | 10 | 0 | 0 | 10 | 0% | 30092.30 | 0 | 0 |
| B0 | F10 Hotel cannot be cancelled, flight refuses | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | C0 Healthy control, no faults | 10 | 10 | 0 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F1 Flight reprices between quote and payment | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F2 Flight inventory gone at commit | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F3 Hotel refuses the booking after the flight confirmed | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F4 Flight accepted asynchronously, then fails | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F5 Flight booked but the response is lost | 10 | 10 | 0 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F6 Hotel times out and nothing was booked | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F7 Hotel says confirmed but no booking exists | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F8 Flight response lost, supplier duplicates on retry | 10 | 10 | 0 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F9 Non-refundable flight, hotel refuses | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |
| B1 | F10 Hotel cannot be cancelled, flight refuses | 10 | 0 | 10 | 0 | 100% | 0.00 | 0 | 0 |

| Arm | Runs | CTR | Completion when feasible | Orphan USD / 100 trips | Duplicate orders | Belief mismatches | Unknown beliefs | Mean supplier calls |
|---|---|---|---|---|---|---|---|---|
| B0 | 110 | 36% | 25% | 24914.94 | 20 | 20 | 30 | 3.6 |
| B1 | 110 | 100% | 75% | 0.00 | 0 | 0 | 0 | 8.7 |
