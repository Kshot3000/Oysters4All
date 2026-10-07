// Nacre GPU v0.2: fused sparse cuPOW preparation prototype.
// Independent proposed optimization; not a complete miner or proof generator.
// SPDX-License-Identifier: MIT
// Build on an NVIDIA CUDA system: nvcc -O3 -std=c++17 nacre_gpu.cu -o nacre_gpu
// No CUDA compiler/device was available in the authoring environment.
// A successful self-test still DOES NOT establish compatibility with Pearl.
#include <cuda_runtime.h>
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

static void ck(cudaError_t e, const char* where) {
  if (e != cudaSuccess)
    throw std::runtime_error(std::string(where) + ": " + cudaGetErrorString(e));
}

template<class T> struct DeviceBuffer {
  T* p = nullptr;
  explicit DeviceBuffer(size_t n) { ck(cudaMalloc(reinterpret_cast<void**>(&p), n*sizeof(T)), "cudaMalloc"); }
  ~DeviceBuffer() { if (p) cudaFree(p); }
  DeviceBuffer(const DeviceBuffer&) = delete;
  DeviceBuffer& operator=(const DeviceBuffer&) = delete;
};

// Convert canonical K x R factors into four byte-sized indices per k.
// This adapter is deliberately simple. Production can emit identical indices
// from the existing noise generator ONLY after seed-by-seed equivalence tests.
__global__ void pack_sparse_maps(const int8_t* SA, const int8_t* SB,
                                uint32_t* maps, int K, int R, int* error) {
  int k = blockIdx.x*blockDim.x + threadIdx.x;
  if (k >= K) return;
  int ap=-1, an=-1, bp=-1, bn=-1;
  int acp=0, acn=0, bcp=0, bcn=0, invalid=0;
  for (int r=0; r<R; ++r) {
    int a=SA[size_t(k)*R+r], b=SB[size_t(k)*R+r];
    if(a==1) {ap=r; ++acp;} else if(a==-1) {an=r; ++acn;} else if(a!=0) invalid=1;
    if(b==1) {bp=r; ++bcp;} else if(b==-1) {bn=r; ++bcn;} else if(b!=0) invalid=1;
  }
  if (invalid || acp!=1 || acn!=1 || bcp!=1 || bcn!=1) {
    atomicExch(error,1); maps[k]=0; return;
  }
  maps[k]=uint32_t(ap) | (uint32_t(an)<<8) | (uint32_t(bp)<<16) | (uint32_t(bn)<<24);
}

// One CUDA block owns one row; integer accumulation uses shared-memory atomics.
// A lane: Y=A+LA*SA^T, G=A*SB.
// B lane: Y=B+LB*SB^T, G=Y*SA. B is stored N x K, not K x N.
// R in {64,128}, X in [-64,63], L in [-32,31], K<=2^20.
// All outputs are unusable if *error != 0 after completion.
template<bool B_LANE>
__global__ void fused_sparse_prepare(const int8_t* X, const int8_t* L,
                                     const uint32_t* maps, int8_t* Y,
                                     int32_t* G, int rows, int K, int R,
                                     int* error) {
  __shared__ int32_t sums[128];
  __shared__ int8_t factors[128];
  int row=blockIdx.x, tid=threadIdx.x;
  if (row>=rows) return; // block-uniform; no divergence around barriers
  for (int r=tid;r<R;r+=blockDim.x) {
    sums[r]=0;
    int l=L[size_t(row)*R+r];
    if (l < -32 || l > 31) atomicExch(error,1);
    factors[r]=static_cast<int8_t>(l);
  }
  __syncthreads();
  for (int k=tid;k<K;k+=blockDim.x) {
    uint32_t z=maps[k];
    int ap=z&255, an=(z>>8)&255, bp=(z>>16)&255, bn=(z>>24)&255;
    if(ap>=R || an>=R || bp>=R || bn>=R || ap==an || bp==bn) {
      atomicExch(error,1); Y[size_t(row)*K+k]=0; continue;
    }
    int np=B_LANE?bp:ap, nn=B_LANE?bn:an;
    int cp=B_LANE?ap:bp, cn=B_LANE?an:bn;
    int x=X[size_t(row)*K+k];
    int y=x+int(factors[np])-int(factors[nn]);
    if(x < -64 || x > 63 || y < -128 || y > 127) {
      atomicExch(error,1); Y[size_t(row)*K+k]=0; continue;
    }
    Y[size_t(row)*K+k]=static_cast<int8_t>(y);
    int v=B_LANE?y:x;
    atomicAdd(&sums[cp],v);
    atomicAdd(&sums[cn],-v);
  }
  __syncthreads();
  for(int r=tid;r<R;r+=blockDim.x) G[size_t(row)*R+r]=sums[r];
}

void launch_nacre(const int8_t* A,const int8_t* B,const int8_t* LA,const int8_t* LB,
                  const uint32_t* maps,int8_t* AP,int8_t* BP,int32_t* U,int32_t* V,
                  int M,int N,int K,int R,int* error,cudaStream_t stream=0) {
  if(M<=0 || N<=0 || K<=0 || K>(1<<20) || (R!=64 && R!=128))
    throw std::invalid_argument("unsupported dimensions/rank");
  // Caller owns non-overlapping buffers, validated shapes, initialization of
  // error, and stream dependencies. This API does not clear a previous error.
  fused_sparse_prepare<false><<<M,256,0,stream>>>(A,LA,maps,AP,U,M,K,R,error);
  ck(cudaGetLastError(),"prepare A launch");
  fused_sparse_prepare<true><<<N,256,0,stream>>>(B,LB,maps,BP,V,N,K,R,error);
  ck(cudaGetLastError(),"prepare B launch");
}

template<class T> static void upload(T* d,const std::vector<T>& h) {
  ck(cudaMemcpy(d,h.data(),h.size()*sizeof(T),cudaMemcpyHostToDevice),"upload");
}
template<class T> static std::vector<T> download(T* d,size_t n) {
  std::vector<T> h(n);ck(cudaMemcpy(h.data(),d,n*sizeof(T),cudaMemcpyDeviceToHost),"download");return h;
}

static void self_test(int R, bool concentrated) {
  const int M=33,N=65,K=257;
  std::mt19937 rng(20261007+R+int(concentrated));
  std::uniform_int_distribution<int> xdist(-64,63),ldist(-32,31),idx(0,R-1);
  std::vector<int8_t> a(M*K),b(N*K),la(M*R),lb(N*R),sa(K*R,0),sb(K*R,0);
  for(auto& v:a)v=xdist(rng);for(auto& v:b)v=xdist(rng);
  for(auto& v:la)v=ldist(rng);for(auto& v:lb)v=ldist(rng);
  for(int k=0;k<K;++k)for(auto* s:{&sa,&sb}) {
    int p=concentrated?0:idx(rng), n=concentrated?1:idx(rng);
    while(n==p)n=idx(rng);
    (*s)[k*R+p]=1;(*s)[k*R+n]=-1;
  }
  std::vector<int8_t> ap(M*K),bp(N*K);
  std::vector<int32_t> u(M*R,0),v(N*R,0);
  // Deliberately independent dense CPU baseline, not the sparse implementation.
  for(int i=0;i<M;++i)for(int k=0;k<K;++k) {
    int z=a[i*K+k];for(int r=0;r<R;++r)z+=int(la[i*R+r])*sa[k*R+r];ap[i*K+k]=int8_t(z);
    for(int r=0;r<R;++r)u[i*R+r]+=int(a[i*K+k])*sb[k*R+r];
  }
  for(int j=0;j<N;++j)for(int k=0;k<K;++k) {
    int z=b[j*K+k];for(int r=0;r<R;++r)z+=int(lb[j*R+r])*sb[k*R+r];bp[j*K+k]=int8_t(z);
    for(int r=0;r<R;++r)v[j*R+r]+=z*sa[k*R+r];
  }
  DeviceBuffer<int8_t> da(a.size()),db(b.size()),dla(la.size()),dlb(lb.size()),dsa(sa.size()),dsb(sb.size()),dap(ap.size()),dbp(bp.size());
  DeviceBuffer<int32_t> du(u.size()),dv(v.size());DeviceBuffer<uint32_t> dm(K);DeviceBuffer<int> de(1);
  upload(da.p,a);upload(db.p,b);upload(dla.p,la);upload(dlb.p,lb);upload(dsa.p,sa);upload(dsb.p,sb);
  ck(cudaMemset(de.p,0,sizeof(int)),"clear error");
  pack_sparse_maps<<<(K+127)/128,128>>>(dsa.p,dsb.p,dm.p,K,R,de.p);
  ck(cudaGetLastError(),"map launch");
  launch_nacre(da.p,db.p,dla.p,dlb.p,dm.p,dap.p,dbp.p,du.p,dv.p,M,N,K,R,de.p);
  ck(cudaDeviceSynchronize(),"self-test completion");
  if(download(de.p,1)[0] || download(dap.p,ap.size())!=ap || download(dbp.p,bp.size())!=bp ||
     download(du.p,u.size())!=u || download(dv.p,v.size())!=v)
    throw std::runtime_error("GPU/CPU mismatch");
  // Matrix identity AB^T = A'B'^T - LA*V^T - U*LB^T on small test dimensions.
  for(int i=0;i<M;++i)for(int j=0;j<N;++j) {
    int64_t expected=0,got=0;
    for(int k=0;k<K;++k){expected+=int64_t(a[i*K+k])*b[j*K+k];got+=int64_t(ap[i*K+k])*bp[j*K+k];}
    for(int r=0;r<R;++r)got-=int64_t(la[i*R+r])*v[j*R+r]+int64_t(u[i*R+r])*lb[j*R+r];
    if(got!=expected)throw std::runtime_error("recovery identity mismatch");
  }
  std::cout<<"PASS rank="<<R<<" concentrated="<<concentrated<<"\n";
}

static void benchmark(int M,int N,int K,int R,int reps) {
  if(M<=0||N<=0||M>(1<<20)||N>(1<<20)||K<=0||K>(1<<20)||
     (R!=64&&R!=128)||reps<1||reps>10000)
    throw std::invalid_argument("benchmark dimensions or repetition limit");
  size_t ak=size_t(M)*K,bk=size_t(N)*K,ar=size_t(M)*R,br=size_t(N)*R;
  std::vector<int8_t> a(ak),b(bk),la(ar),lb(br);std::vector<uint32_t> maps(K);
  std::mt19937 rng(20261007);std::uniform_int_distribution<int> xd(-64,63),ld(-32,31),ix(0,R-1);
  for(auto& z:a)z=xd(rng);for(auto& z:b)z=xd(rng);
  for(auto& z:la)z=ld(rng);for(auto& z:lb)z=ld(rng);
  for(auto& z:maps) {
    int ap=ix(rng),an=ix(rng),bp=ix(rng),bn=ix(rng);
    while(an==ap)an=ix(rng);while(bn==bp)bn=ix(rng);
    z=uint32_t(ap)|(uint32_t(an)<<8)|(uint32_t(bp)<<16)|(uint32_t(bn)<<24);
  }
  DeviceBuffer<int8_t> da(ak),db(bk),dla(ar),dlb(br),dap(ak),dbp(bk);
  DeviceBuffer<int32_t> du(ar),dv(br);DeviceBuffer<uint32_t> dm(K);DeviceBuffer<int> de(1);
  upload(da.p,a);upload(db.p,b);upload(dla.p,la);upload(dlb.p,lb);upload(dm.p,maps);
  ck(cudaMemset(de.p,0,sizeof(int)),"clear benchmark error");
  auto run=[&](){launch_nacre(da.p,db.p,dla.p,dlb.p,dm.p,dap.p,dbp.p,du.p,dv.p,M,N,K,R,de.p);};
  for(int i=0;i<10;++i)run();ck(cudaDeviceSynchronize(),"warmup");
  cudaEvent_t begin,end;ck(cudaEventCreate(&begin),"event create");ck(cudaEventCreate(&end),"event create");
  ck(cudaEventRecord(begin),"event record");for(int i=0;i<reps;++i)run();
  ck(cudaEventRecord(end),"event record");ck(cudaEventSynchronize(end),"event wait");
  float ms=0;ck(cudaEventElapsedTime(&ms,begin,end),"event elapsed");
  cudaEventDestroy(begin);cudaEventDestroy(end);
  if(download(de.p,1)[0])throw std::runtime_error("benchmark input/output guard failed");
  std::cout<<"preparation_only_mean_ms="<<ms/reps<<" M="<<M<<" N="<<N<<" K="<<K<<" R="<<R<<"\n";
  std::cout<<"Synthetic hot-buffer microbenchmark; excludes map generation, conversion, main GEMM, hashing and proof.\n";
}

int main(int argc,char** argv) {
  try {
    if(argc==7 && std::string(argv[1])=="--bench") {
      benchmark(std::stoi(argv[2]),std::stoi(argv[3]),std::stoi(argv[4]),std::stoi(argv[5]),std::stoi(argv[6]));return 0;
    }
    if(argc!=1)throw std::invalid_argument("usage: nacre_gpu [--bench M N K R repetitions]");
    for(int r:{64,128})for(bool hot:{false,true})self_test(r,hot);
    std::cout<<"Synthetic preparation checks passed. Pearl integration/benchmarks still required.\n";
    return 0;
  } catch(const std::exception& e) {std::cerr<<e.what()<<"\n";return 1;}
}
