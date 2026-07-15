# WatsUp Refactoring Performance Baselines

This document logs the baseline footprint and performance measurements recorded prior to the architectural refactoring.

## Environment Details
- **Operating System:** Microsoft Windows NT 10.0.19045.0
- **Linux Environment:** pending
- **Docker Environment:** pending (sandbox network block prevents apt/nodesource fetch)
- **Node.js Version:** v22.17.0
- **Python Version:** 3.13.5

## Measurement Protocol
1. **Node.js Engine Footprint:** Start `node engine.js`, wait 4 seconds (warm-up), and record three samples of the resident set size (RSS / WorkingSet64) at 1-second intervals.
2. **Local Pipeline Throughput:** Run `npm run benchmark:local`, which starts an Express server instance on an ephemeral port using a mock socket that fully consumes the streamed content. Measure duration and throughput over 5 rounds and compute the median.

## Performance Metrics

### 1. Idle Footprint (Warm state)
- **Node.js Engine (idle RSS):** 126.57 MB, 126.57 MB, 126.57 MB (Median: 126.57 MB)
- **Python UI (idle RSS):** pending (requires secure test harness to isolate UI libraries loading memory)

### 2. Local Stream Pipeline Throughput (Mock Socket Sink)
Measured by reading a 10MB test payload piped via `ProgressStream` inside `createApp` to the mock socket stream consumer (5 rounds):
- **Round 1:** 36.04 ms (277.45 MB/s)
- **Round 2:** 12.14 ms (823.51 MB/s)
- **Round 3:** 28.74 ms (347.97 MB/s)
- **Round 4:** 11.82 ms (846.30 MB/s)
- **Round 5:** 11.01 ms (908.23 MB/s)

- **Median Duration:** 12.14 ms
- **Median Throughput:** 823.51 MB/s

> [!NOTE]
> The local pipeline benchmark measures only the local Express routing, file reading, and progress stream piping layers. It does not reflect WhatsApp server connection limits, network latency, or remote API ingestion performance.
