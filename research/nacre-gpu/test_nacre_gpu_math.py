"""CPU oracle tests for Nacre GPU math; these do not compile or execute CUDA."""
import json
from pathlib import Path
import numpy as np

rng=np.random.default_rng(20261007)
cases=0
for R in [64,128]:
  for K in [1,31,64,257,1024]:
    for hot in [False,True]:
      for repeat in range(5):
        M,N=7,11
        A=rng.integers(-64,64,(M,K),dtype=np.int64)
        B=rng.integers(-64,64,(N,K),dtype=np.int64)
        LA=rng.integers(-32,32,(M,R),dtype=np.int64)
        LB=rng.integers(-32,32,(N,R),dtype=np.int64)
        PA=rng.integers(0,R,K);NA=(PA+rng.integers(1,R,K))%R
        PB=rng.integers(0,R,K);NB=(PB+rng.integers(1,R,K))%R
        if hot:PA[:]=PB[:]=0;NA[:]=NB[:]=1
        SA=np.zeros((K,R),dtype=np.int64);SB=np.zeros((K,R),dtype=np.int64)
        SA[np.arange(K),PA]=1;SA[np.arange(K),NA]=-1
        SB[np.arange(K),PB]=1;SB[np.arange(K),NB]=-1
        AP=A+LA[:,PA]-LA[:,NA];BP=B+LB[:,PB]-LB[:,NB]
        U=np.zeros((M,R),dtype=np.int64);V=np.zeros((N,R),dtype=np.int64)
        for k in range(K):
          U[:,PB[k]]+=A[:,k];U[:,NB[k]]-=A[:,k]
          V[:,PA[k]]+=BP[:,k];V[:,NA[k]]-=BP[:,k]
        assert np.array_equal(AP,A+LA@SA.T)
        assert np.array_equal(BP,B+LB@SB.T)
        assert np.array_equal(U,A@SB)
        assert np.array_equal(V,BP@SA)
        assert np.array_equal(AP@BP.T-LA@V.T-U@LB.T,A@B.T)
        assert -128<=AP.min()<=AP.max()<=127
        assert -128<=BP.min()<=BP.max()<=127
        cases+=1
assert 127*(1<<20)<2**31
result={'seed':20261007,'cases':cases,'ranks':[64,128],'K':[1,31,64,257,1024],
        'checks_per_case':['A noising','B noising','A correction','B correction','full integer recovery','A int8 range','B int8 range'],
        'distribution_cases':['random sparse indices','concentrated shared-memory contention pattern'],
        'cuda_compiled':False,'cuda_executed':False,'scope':'CPU mathematical equivalence only'}
Path(__file__).with_name('nacre_gpu_math_results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
