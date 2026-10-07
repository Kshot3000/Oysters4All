"""Nacre v0.1: CPU reference experiments. Not a miner or consensus implementation.

Run: python3 nacre_reference.py --out results.json
Python standard library only. Reproducible with Python 3.11+.
The test key/MAC below is a test authenticator, NOT a production signature scheme.
"""
import argparse
import copy
import hashlib
import hmac
import json
import math
import random
from pathlib import Path

SEED = 20261007


def encode(fields):
    """Length-prefixed bytes, not a complete production wire schema."""
    out = bytearray()
    for v in fields:
        if not isinstance(v, bytes):
            raise TypeError('encoded fields must be bytes')
        out += len(v).to_bytes(4, 'little') + v
    return bytes(out)


def digest(domain, fields):
    return hashlib.sha256(domain + b'\0' + encode(fields)).hexdigest()


def u64(v):
    if type(v) is not int or not 0 <= v < 2**64:
        raise ValueError('u64 required')
    return v.to_bytes(8, 'little')


def job_id(j):
    return digest(b'pearl/nacre/job/v1', [
        bytes.fromhex(j['chain']), bytes.fromhex(j['payer']),
        bytes.fromhex(j['nonce']), bytes.fromhex(j['model']),
        bytes.fromhex(j['input']), bytes.fromhex(j['generation']),
        u64(j['deadline_ms']), u64(j['max_tokens']), u64(j['max_fee']),
        bytes.fromhex(j['verifier'])])


def receipt_id(r):
    return digest(b'pearl/nacre/receipt/v1', [
        bytes.fromhex(r['job']), u64(r['seq']), u64(r['start']),
        u64(r['end']), u64(r['charge']), bytes.fromhex(r['output'])])


class Ledger:
    """Atomic, single-broker ledger model; no blockchain, database, or signatures."""
    def __init__(self, j, balance):
        self.j = copy.deepcopy(j)
        self.jid = job_id(j)
        self.escrow = min(balance, j['max_fee'])
        self.total = self.escrow
        self.provider = self.audit = self.protocol = self.refund = 0
        self.next_token = self.next_seq = 0
        self.closed = False

    def settle(self, r, authenticated=True):
        if not authenticated or self.closed or r['job'] != self.jid:
            raise ValueError('identity/auth/state')
        for k in ('seq', 'start', 'end', 'charge'):
            u64(r[k])
        if r['seq'] != self.next_seq or r['start'] != self.next_token:
            raise ValueError('replay, gap, or overlap')
        if not r['start'] < r['end'] <= self.j['max_tokens']:
            raise ValueError('token bound')
        if r['charge'] > self.escrow:
            raise ValueError('budget')
        # Example fee schedule in integer accounting units, not token economics.
        audit = r['charge'] // 10
        protocol = r['charge'] // 20
        self.audit += audit
        self.protocol += protocol
        self.provider += r['charge'] - audit - protocol
        self.escrow -= r['charge']
        self.next_token = r['end']
        self.next_seq += 1
        self.invariant()

    def close(self):
        if self.closed:
            raise ValueError('closed')
        self.refund += self.escrow
        self.escrow = 0
        self.closed = True
        self.invariant()

    def invariant(self):
        assert min(self.escrow, self.provider, self.audit,
                   self.protocol, self.refund) >= 0
        assert self.total == (self.escrow + self.provider + self.audit
                              + self.protocol + self.refund)


def percentile(xs, q):
    a = sorted(xs)
    return a[min(len(a)-1, math.ceil(q * len(a))-1)]


def make_trace(n=10000):
    r = random.Random(SEED)
    rows = []
    for _ in range(n):
        base = r.uniform(8, 40)
        slack = r.uniform(.01, .15) * base
        pressure = r.random() < .12
        ops = []
        for k in range(12):
            eligible = r.random() < .75
            upper = r.uniform(.04, .24)
            actual = upper * r.uniform(.60, 1.00)
            if r.random() < .01:
                actual *= 2.0  # rare bound violation / runtime shock
            weight = r.uniform(1, 20)
            ops.append((eligible, upper, actual, weight, k))
        rows.append((base, slack, pressure, ops))
    return rows


def simulate(rows, alpha=None, calibration=1.0):
    overhead, relative, accepted_work = [], [], 0
    available_work = sum(sum(o[3] for o in ops if o[0]) for *_, ops in rows)
    late = reservation_failures = 0
    for base, slack, pressure, ops in rows:
        eligible = [o for o in ops if o[0]]
        if alpha is None:  # fixed-profile serving without mining
            chosen = []
        elif alpha == -1:  # shape-only proxy; not measured Pearl performance
            chosen = eligible
        else:
            budget = min(alpha * base, max(0., slack - .25))
            chosen = []
            remaining = budget
            if not pressure:
                for o in sorted(eligible, key=lambda x: x[3]/x[1], reverse=True):
                    reserve = calibration * o[1]
                    if reserve <= remaining:
                        chosen.append(o)
                        remaining -= reserve
            assert sum(calibration * o[1] for o in chosen) <= budget + 1e-9
            if sum(o[2] for o in chosen) > budget + 1e-9:
                reservation_failures += 1
        added = sum(o[2] for o in chosen)
        accepted_work += sum(o[3] for o in chosen)
        overhead.append(added)
        relative.append(100 * added/base)
        late += added > slack
    base_sum = sum(row[0] for row in rows)
    return {
        'batches': len(rows), 'median_added_ms': percentile(overhead,.5),
        'p99_added_percent': percentile(relative,.99),
        'deadline_miss_percent': 100*late/len(rows),
        'work_retained_percent': 100*accepted_work/available_work,
        'serial_capacity_percent': 100*base_sum/(base_sum + sum(overhead)),
        'actual_budget_overruns': reservation_failures,
    }


def matmul(a,b):
    return [[sum(x*y for x,y in zip(row,col)) for col in zip(*b)] for row in a]


def add(a,b,sign=1):
    return [[x+sign*y for x,y in zip(ra,rb)] for ra,rb in zip(a,b)]


def check_freivalds(a,b,c,r,p):
    def mv(m,v):
        return [sum(x*y for x,y in zip(row,v)) % p for row in m]
    return mv(a,mv(b,r)) == mv(c,r)


def mechanism_tests():
    passed = []
    def test(name, f):
        f()
        passed.append(name)
    def rejects(f):
        try:
            f()
        except (ValueError, TypeError):
            return
        raise AssertionError('must reject')

    j = {k: hashlib.sha256(k.encode()).hexdigest() for k in
         ['chain','payer','nonce','model','input','generation','verifier']}
    j.update(deadline_ms=2000000000000,max_tokens=100,max_fee=1000)
    def changed_binding():
        h = job_id(j)
        for k in j:
            jj = dict(j)
            jj[k] = j[k]+1 if isinstance(j[k],int) else '00'+j[k][2:]
            assert job_id(jj) != h
    test('job binding: every field changes ID', changed_binding)
    test('length prefixes separate ambiguous concatenations', lambda:
         assert_true(digest(b'd',[b'ab',b'c']) != digest(b'd',[b'a',b'bc'])))
    test('hash domains are distinct',lambda:
         assert_true(digest(b'job',[b'a']) != digest(b'receipt',[b'a'])))
    r0 = dict(job=job_id(j),seq=0,start=0,end=10,charge=200,output='11'*32)
    def replay():
        l=Ledger(j,1000);l.settle(r0);rejects(lambda:l.settle(r0))
    test('duplicate receipt rejected',replay)
    def overlap():
        l=Ledger(j,1000);l.settle(r0)
        rejects(lambda:l.settle(dict(r0,seq=1,start=9,end=15)))
    test('overlapping token range rejected',overlap)
    test('insufficient budget rejected',lambda:rejects(
        lambda:Ledger(j,50).settle(r0)))
    test('token cap enforced',lambda:rejects(
        lambda:Ledger(j,1000).settle(dict(r0,end=101))))
    test('wrong job rejected',lambda:rejects(
        lambda:Ledger(j,1000).settle(dict(r0,job='00'*32))))
    test('negative fee rejected',lambda:rejects(
        lambda:Ledger(j,1000).settle(dict(r0,charge=-1))))
    def tamper():
        key=b'test-only-key'
        mac=hmac.digest(key,bytes.fromhex(receipt_id(r0)),'sha256')
        altered=dict(r0,output='22'*32)
        valid=hmac.compare_digest(mac,hmac.digest(key,bytes.fromhex(receipt_id(altered)),'sha256'))
        rejects(lambda:Ledger(j,1000).settle(altered,authenticated=valid))
    test('tampered authenticated receipt rejected (test MAC)',tamper)
    def conserve():
        l=Ledger(j,1000);l.settle(r0)
        l.settle(dict(r0,seq=1,start=10,end=20,charge=300));l.close()
        assert (l.provider,l.audit,l.protocol,l.refund)==(425,50,25,500)
        rejects(lambda:l.settle(dict(r0,seq=2,start=20,end=30)))
        rejects(l.close)
    test('conservation, refund, and terminal state',conserve)
    rnd=random.Random(SEED+1)
    def algebra():
        for _ in range(500):
            a=[[rnd.randrange(-63,64) for _ in range(8)] for _ in range(6)]
            b=[[rnd.randrange(-63,64) for _ in range(5)] for _ in range(8)]
            e=matmul([[rnd.randrange(-2,3)] for _ in range(6)],[[rnd.randrange(-2,3) for _ in range(8)]])
            f=matmul([[rnd.randrange(-2,3)] for _ in range(8)],[[rnd.randrange(-2,3) for _ in range(5)]])
            recovered=add(add(add(matmul(add(a,e),add(b,f)),matmul(e,b),-1),matmul(a,f),-1),matmul(e,f),-1)
            assert recovered==matmul(a,b)
    test('500 exact low-rank noise recovery identities',algebra)
    a=[[2,3],[4,5]];b=[[6,7],[8,9]];c=matmul(a,b)
    test('correct matrix passes field check',lambda:
         assert_true(check_freivalds(a,b,c,[4,7],101)))
    corrupted=copy.deepcopy(c);corrupted[0][0]+=1
    rr=random.Random(SEED+2)
    escapes=sum(check_freivalds(a,b,corrupted,[rr.randrange(101),rr.randrange(101)],101) for _ in range(10000))
    test('known corrupted matrix has observed escapes below 2%',lambda:
         assert_true(escapes<200))
    def adaptive():
        r=[4,7];fake=copy.deepcopy(c)
        fake[0][0]+=7;fake[0][1]-=4
        assert fake != c and check_freivalds(a,b,fake,r,101)
    test('known challenge permits adaptive forgery (negative control)',adaptive)
    return {'passed_count':len(passed),'cases':passed,
            'freivalds_toy_prime':101,'freivalds_trials':10000,
            'freivalds_false_accepts':escapes}


def assert_true(x):
    assert x


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',default='results.json')
    args=parser.parse_args()
    trace=make_trace()
    results={'seed':SEED,'scope':'synthetic CPU mechanism experiments; no GPU benchmark',
        'scheduler':{'fixed_profile':simulate(trace),
                     'shape_only_proxy':simulate(trace,-1),
                     'nacre_2pct':simulate(trace,.02),
                     'nacre_5pct':simulate(trace,.05),
                     'nacre_10pct':simulate(trace,.10)},
        'sensitivity':{str(c):simulate(trace,.05,c) for c in [1.,.75,.5]},
        'tests':mechanism_tests(),
        'audit_detection':{str(f):{str(q):1-(1-f)**q for q in [16,64,256,300,600]}
                           for f in [.001,.01,.05]}}
    Path(args.out).write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(results,indent=2))


if __name__=='__main__':
    main()
