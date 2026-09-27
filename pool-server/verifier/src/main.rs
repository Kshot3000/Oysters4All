// pearl-pool-verifier — share verification worker for the Pearl open-source mining pool.
//
// Verifies miner-submitted `plain_proof` shares against pool share targets using the
// vendored zk-pow verifier — the same code path the reference pools use
// (`verify_plain_proof`, plus `check_cert_version_eligible` and duplicate detection
// by the caller). See `crates/spm-mockpool` in xXGuilasXx/spark-pearl-miner for the
// reference pool-side flow this mirrors.
//
// Protocol: line-delimited JSON on stdin, one response object per line on stdout.
//
// Request:
//   {"header":"<152 hex chars, 76-byte IncompleteBlockHeader>",
//!    "proof_b64":"<base64 of bincode(PlainProof), optionally compressed>",
//    "encoding":"plain"|"zstd"|"gzip",   // how proof_b64 is compressed
//    "nbits":<u32>,                        // compact share target to verify against
//    "cert_version":<u32>}                  // cert version the pool advertised (3 = V3 salted)
//
// Response (success):
//   {"ok":true,"digest":"<hex sha256 of the decoded proof bytes>","block":<bool>}
//     `block` is true when the share ALSO meets the header's network nbits
//     (i.e. it is a block candidate, not just a pool share).
// Response (failure):
//   {"ok":false,"error":"<human-readable reason>"}
//
// The process stays alive and handles requests sequentially; the pool server runs
// a small pool of these workers and round-robins verification jobs.

use std::io::{BufRead, Write};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zk_pow::api::proof::{IncompleteBlockHeader, SeedDerivation};
use zk_pow::api::verify::verify_plain_proof;
use zk_pow::ffi::plain_proof::{check_cert_version_eligible, CertificateVersion, PlainProof};

/// Matches spm-proto's MAX_DECODED_PROOF: never inflate a proof beyond 16 MiB.
const MAX_DECODED_PROOF: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct VerifyRequest {
    /// Opaque tag echoed back so the pool can route responses to requests.
    #[serde(default)]
    _seq: Option<u64>,
    header: String,
    proof_b64: String,
    encoding: String,
    nbits: u32,
    cert_version: u32,
}

#[derive(Debug, Serialize)]
struct VerifyResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    _seq: Option<u64>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    block: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn fail(seq: Option<u64>, msg: impl Into<String>) -> VerifyResponse {
    VerifyResponse { _seq: seq, ok: false, digest: None, block: None, error: Some(msg.into()) }
}

fn sniff_compressed(raw: &[u8]) -> bool {
    // zstd magic 28 B5 2F FD, gzip magic 1F 8B (mirrors spm-proto's sniff_encoding).
    raw.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) || raw.starts_with(&[0x1f, 0x8b])
}

fn decode_proof(b64: &str, encoding: &str) -> Result<Vec<u8>, String> {
    if b64.len() / 4 * 3 > MAX_DECODED_PROOF {
        return Err(format!("decoded proof would exceed {MAX_DECODED_PROOF} bytes"));
    }
    let raw = B64.decode(b64.trim()).map_err(|e| format!("base64: {e}"))?;
    match encoding {
        "plain" => {
            if sniff_compressed(&raw) {
                return Err("bad proof format: compressed data in plain_proof".to_string());
            }
            Ok(raw)
        }
        "zstd" => {
            let mut dec = zstd::stream::read::Decoder::new(&raw[..])
                .map_err(|e| format!("zstd: {e}"))?;
            let mut out = Vec::new();
            use std::io::Read;
            dec.take(MAX_DECODED_PROOF as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|e| format!("zstd: {e}"))?;
            if out.len() > MAX_DECODED_PROOF {
                return Err(format!("decoded proof exceeds {MAX_DECODED_PROOF} bytes"));
            }
            Ok(out)
        }
        "gzip" => {
            use flate2::read::GzDecoder;
            use std::io::Read;
            let mut out = Vec::new();
            GzDecoder::new(&raw[..])
                .take(MAX_DECODED_PROOF as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|e| format!("gzip: {e}"))?;
            if out.len() > MAX_DECODED_PROOF {
                return Err(format!("decoded proof exceeds {MAX_DECODED_PROOF} bytes"));
            }
            Ok(out)
        }
        other => Err(format!("unknown proof encoding: {other}")),
    }
}

fn verify(seq: Option<u64>, req: &VerifyRequest) -> VerifyResponse {
    // 1. Header: 152 hex chars -> 76 bytes, validated by from_bytes (layout + roundtrip).
    let header_bytes = hex::decode(req.header.trim())
        .map_err(|e| format!("bad job header hex: {e}"))
        .and_then(|b| {
            if b.len() == IncompleteBlockHeader::SERIALIZED_SIZE {
                Ok(b)
            } else {
                Err(format!("bad job header: expected 76 bytes, got {}", b.len()))
            }
        });
    let header_bytes = match header_bytes {
        Ok(b) => b,
        Err(e) => return fail(seq, e),
    };
    let header = match IncompleteBlockHeader::from_bytes(&header_bytes) {
        Ok(h) => h,
        Err(e) => return fail(seq, format!("bad job header: {e}")),
    };

    // 2. Decode (+decompress) the proof.
    let bytes = match decode_proof(&req.proof_b64, &req.encoding) {
        Ok(b) => b,
        Err(e) => return fail(seq, e),
    };
    let digest: [u8; 32] = Sha256::digest(&bytes).into();

    // 3. Deserialize the PlainProof (bincode, compat mode like the pools use).
    let proof = match PlainProof::deserialize_compat(&bytes) {
        Ok(p) => p,
        Err(e) => return fail(seq, format!("failed to deserialize proof: {e}")),
    };

    // 4. Certificate version eligibility (mirrors spm-mockpool / spm-work).
    // V3 = salted seed derivation (post salted-seed fork); V1/V2 = legacy.
    let seed_derivation = match req.cert_version {
        3 => SeedDerivation::Salted,
        1 | 2 => SeedDerivation::Legacy,
        v => return fail(seq, format!("unsupported cert_version for verification: {v}")),
    };
    if let Err(e) = check_cert_version_eligible(req.cert_version, &proof) {
        return fail(seq, format!("certificate version not eligible: {e}"));
    }
    // Silence the unused import if the mapping above ever changes; kept explicit.
    let _ = CertificateVersion::try_from(req.cert_version);

    // 5. The share check, exactly as pools do: jackpot recomputed and checked
    //    against the pool share target (nbits_override = share nbits).
    if let Err(e) = verify_plain_proof(&header, &proof, Some(req.nbits), seed_derivation) {
        return fail(seq, format!("Invalid proof: {e}"));
    }

    // 6. Block detection: does the share also meet the header's network nbits?
    let block = verify_plain_proof(&header, &proof, None, seed_derivation).is_ok();

    VerifyResponse {
        _seq: seq,
        ok: true,
        digest: Some(hex::encode(digest)),
        block: Some(block),
        error: None,
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<VerifyRequest>(&line) {
            Ok(req) => verify(req._seq, &req),
            Err(e) => fail(None, format!("bad request: {e}")),
        };
        let mut s = serde_json::to_string(&resp).unwrap_or_else(|_| r#"{"ok":false,"error":"serialize"}"#.to_string());
        s.push('\n');
        if out.write_all(s.as_bytes()).is_err() {
            break;
        }
        let _ = out.flush();
    }
}
