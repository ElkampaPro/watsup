# WatsUp Refactoring Performance Baselines

This document logs the baseline footprint and performance measurements recorded prior to the architectural refactoring.

## Environment Details
- **Operating System:** Microsoft Windows NT 10.0.19045.0
- **Linux Environment:** pending
- **Docker Environment:** pending (sandbox network block prevents apt/nodesource fetch)
- **Node.js Version:** v22.17.0
- **Python Version:** 3.13.5

## Measurement Protocol
1. **Production Node/Baileys RSS:** pending isolated Linux measurement.
2. **Python UI RSS:** pending isolated Linux measurement.
3. **Local Mock Pipeline Throughput:** Run `npm run benchmark:local`, which starts an Express server instance on an ephemeral port using a mock socket that fully consumes the streamed content. Measure duration and throughput over 5 rounds (after 1 warm-up round) and compute the median.

## Performance Metrics

### 1. Idle Footprint (Warm state)
- **Production Node/Baileys RSS:** pending isolated Linux measurement.
- **Python UI RSS:** pending isolated Linux measurement.

### 2. Local Mock Pipeline Throughput (Mock Socket Sink)
Measured by reading a 100MB test payload piped via `ProgressStream` inside `createApp` to the mock socket stream consumer (5 rounds after 1 warm-up round):
- **Warm-up Round:** (Ignored from results)
- **Round 1:** 143.46 ms (697.05 MB/s)
- **Round 2:** 142.57 ms (701.41 MB/s)
- **Round 3:** 222.88 ms (448.68 MB/s)
- **Round 4:** 112.32 ms (890.32 MB/s)
- **Round 5:** 124.68 ms (802.05 MB/s)

- **Median Duration:** 142.57 ms
- **Median Throughput:** 701.41 MB/s

> [!NOTE]
> The mock pipeline benchmark measures only the local Express routing, file reading, and progress stream piping layers. It does not reflect WhatsApp server connection limits, network latency, or remote API ingestion performance.
