# Pearl Nacre GPU v0.2

An independent proposed GPU optimization for Pearl's cuPOW preparation stage.

The core deliverable is `nacre_gpu.cu`: actual CUDA C++ source for a fused sparse
preparation kernel. It uses canonical two-index noise factors to produce noisy
matrix operands and correction terms in one row pass. The intended integration
retains Pearl's existing tensor-core main GEMM, transcript hashing, difficulty
checks, and proof pipeline.

**Status:** 100 CPU mathematical equivalence cases passed. The CUDA code has NOT
been compiled or run in the authoring environment. This is not a complete miner,
a production-ready Pearl patch, or a claim of faster mining. No tokens are mined,
no wallet is accessed, and no network connection is made by these tests.

## Files

- `nacre_gpu.cu`: CUDA map adapter, fused preparation kernels, GPU/CPU self-test,
  and a preparation-only CUDA-event microbenchmark.
- `test_nacre_gpu_math.py`: independent dense NumPy oracle for the proposed math.
- `nacre_gpu_math_results.json`: actual CPU oracle results from this work.
- `nacre_reference.py`: separate standard-library scheduling/accounting experiments.
- `nacre_results.json`: actual results of the scheduling/accounting experiments.
- `SOURCE_CONTEXT.json`: inspected upstream revision and validation status.
- `LICENSE`: MIT license for the original prototype code in this package.

The accompanying PDF explains the algorithm, integration boundaries, serving
controller, receipts, security assumptions, and validation plan. GPU sections are
pages 5-8. The CPU simulation is not a GPU benchmark.

## Build and run on an NVIDIA CUDA system

Install a CUDA Toolkit and supported host C++ compiler compatible with the actual
GPU. Compile for the GPU visible on that system:

```sh
nvcc -O3 -std=c++17 -arch=native nacre_gpu.cu -o nacre_gpu
./nacre_gpu
./nacre_gpu --bench 1024 4096 4096 128 100
```

On Windows, use the configured CUDA/Visual Studio developer command prompt:

```bat
nvcc -O3 -std=c++17 -arch=native nacre_gpu.cu -o nacre_gpu.exe
nacre_gpu.exe
nacre_gpu.exe --bench 1024 4096 4096 128 100
```

The no-argument command runs four CUDA-vs-dense-CPU checks (ranks 64/128, random
and concentrated index patterns). A passing run prints `PASS` and exits zero.
The benchmark arguments are M N K R repetitions. Benchmark timing excludes map
generation, copies, scale conversion, main GEMM, hashing, and proof generation.
It uses synthetic inputs and warm buffers; it cannot establish mining profit or
end-to-end serving speedup. The CUDA launch path is fixed at 256 threads per row.

`-arch=native` targets visible GPUs. Use explicit architecture flags when
cross-compiling, following the installed toolkit's documentation. A 5090 is a
candidate target for this ordinary-CUDA prototype; full Pearl support on that
device is still a separate compatibility task.

## CPU math verification

With Python 3 and NumPy installed:

```sh
python3 test_nacre_gpu_math.py
python3 nacre_reference.py --out nacre_results.json
```

On Windows, replace `python3` with the appropriate Python launcher if needed.
The math oracle covers 100 cases at R=64/128 and K=1/31/64/257/1024. It checks
AP/BP, both correction factors, complete integer recovery, and INT8 ranges.
These tests do not exercise CUDA barriers, race conditions, or device behavior.

## Mathematical interface

Stored A is M x K and stored B is N x K. Dense noise factors LA/LB are M x R and
N x R. Sparse factors SA/SB are K x R with one +1 and one -1 per row.

```
AP = A + LA SA^T
BP = B + LB SB^T
U  = A SB
V  = BP SA
A B^T = AP BP^T - LA V^T - U LB^T
```

**V must use BP, not B.** Otherwise the recovery misses a cross term.

The CUDA adapter `pack_sparse_maps` extracts the four canonical indices into
each uint32 word. Use upstream factors produced by the current seed rules;
the synthetic random factors in the self-test are not cryptographic noise.
`launch_nacre` assumes correctly allocated non-overlapping device buffers,
valid host dimensions, initialized error storage, and ordered stream dependencies.
An error invalidates all outputs and must be resolved before any main mining call.
The prototype does not clear a pre-existing error flag.

## Integration gates

1. Compile and run GPU self-tests, then CUDA memory/race checks on actual hardware.
2. Compare against upstream preparation with real canonical seeds, R/shape
   profiles, edge values, and current certificate versions.
3. Preserve upstream correction conversion and floating-point rounding. Exact
   integer identity alone does not imply identical floating-point epilogue output.
4. Verify byte equality of AP/BP and U/V where the upstream path exposes INT32
   terms; verify the exact converted factors and complete model outputs.
5. Confirm transcript/certificate equivalence and acceptance by unmodified
   applicable Pearl node rules, including salted-seed and rank rules.
6. Measure full preparation, main GEMM, proof overhead, and LLM latency separately.
   Keep the original implementation for shapes where it is faster.

The prototype supports R=64/128, A/B in [-64,63], LA/LB in [-32,31], and
K <= 2^20 for its correction accumulator bound. These local bounds do not
override Pearl's main-GEMM, conversion, tensor-shape, or consensus restrictions.

No replacement cryptographic primitive or claim of patent novelty is made.
This package does not redistribute the upstream Pearl repository. Consult its
own licenses when integrating with it.
