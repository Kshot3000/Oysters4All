# Pearl Nacre GPU — proposal cover note

**For the Pearl team — tagging @pearl-research-labs for review and corrections.**

I'm publishing **Nacre GPU v0.2**, an independent technical proposal for Pearl's
LLM mining (cuPOW), in this repo so the Pearl devs and anyone else can inspect,
test, and push back on it in the open.

- Full proposal: [`Pearl_Nacre_LLM_Mining_Proposal.pdf`](Pearl_Nacre_LLM_Mining_Proposal.pdf) (v0.2, 07 October 2026)
- CUDA prototype + CPU harnesses: this directory (`nacre_gpu.cu`, MIT licensed)
- Status page: [`SOURCE_CONTEXT.json`](SOURCE_CONTEXT.json)

## What it proposes

A **fused sparse preparation kernel** for Pearl's existing cuPOW noising stage.
Pearl's noise factors are sparse (one +1 and one −1 per K row); instead of
forming noisy operands and correction factors with dense tensor-core
preparation, Nacre GPU packs the canonical indices (one uint32 per K) and does
direct gathers plus signed shared-memory integer accumulation — one pass per
operand row — then feeds Pearl's **unchanged** tensor-core GEMM, transcript
hashing, and certificate pipeline. It adds no consensus change: no new proof
type, no issuance change, no block field.

Around the kernel, the proposal adds a budget-aware mining selector (admit
mining work only inside a measured serving-latency budget, with hard gates and
a circuit breaker) and a typed service-receipt layer (V0 attested / V1 sampled
audit / V2 full proof / P Pearl work proof kept strictly separate — a receipt
never alters difficulty or chain weight, and service payments are fee-funded
with zero additional issuance).

## Verified so far (checked in this repo, 2026-10-07)

- Source-file SHA-256 hashes match `SOURCE_CONTEXT.json` exactly.
- CPU math oracle re-run: **100/100 cases pass** (R = 64/128, K = 1/31/64/257/1024;
  AP/BP, both corrections, full integer recovery, INT8 ranges) and reproduce the
  shipped results file byte-for-byte.
- Scheduling/accounting harness re-run: results reproduce the shipped
  `nacre_results.json` exactly (15 mechanism checks; at a 5% latency budget the
  synthetic trace keeps 67.1% of eligible work with 0 observed deadline misses —
  synthetic illustration, **not** a Pearl performance measurement).
- The proposal's source audit is pinned to upstream commit `2f8b770`, which is
  the current `pearl-research-labs/pearl` master tip as of this writing.

## Honest limits — read these before the claims

- **The CUDA code has NOT been compiled or executed yet.** No GPU or `nvcc`
  was available in the authoring or checking environments. No speedup,
  hashrate, or profitability is claimed anywhere in the proposal.
- Adoption criterion (from the proposal): enable Nacre GPU only where
  `T_new < T_old` for the same shape **and** output/certificate equivalence
  tests pass **and** serving quality/SLO gates pass. Tensor-core preparation
  stays as the fallback.
- RTX 5090 (sm_120) is a plausible porting candidate — the prototype uses
  ordinary CUDA blocks/shared atomics, no Hopper-only instructions — but full
  Pearl support on Blackwell is a separate validation task.
- Independent proposal: **not affiliated with or endorsed by Pearl Research
  Labs.**

## What would help most

1. A compile + self-test run on the documented sm_90 (H100/H200) baseline:
   `nvcc -O3 -std=c++17 -arch=native nacre_gpu.cu -o nacre_gpu && ./nacre_gpu`
2. Review of the integration map (proposal §15): preparation adapter at the
   existing kernel decision point in `vllm_kernels.py`, budget settings in
   `vllm_miner/config.py`, bounded proof queues in `async_loop_manager.py`.
3. Corrections — factual errors about Pearl's current implementation are the
   most valuable feedback this can get.

## Support this work

**PRL:** `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

**X:** [@kshot9000](https://x.com/kshot9000) · Pearl on X: [@prlnet](https://x.com/prlnet)
