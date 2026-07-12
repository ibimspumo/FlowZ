# fal.ai pricing sources

Audited on 2026-07-12. The executable, versioned pricing snapshot lives in
`src/nodes/fal-pricing-manifest.json`. FlowZ always displays these values as a
pre-run estimate; provider-reported usage remains authoritative after a run.

| Adapter | Official source | Pre-run behavior |
| --- | --- | --- |
| Nano Banana 2 Lite | https://fal.ai/models/google/nano-banana-2-lite | No numeric estimate: output-token usage is unknown before submission. |
| Nano Banana Pro | https://fal.ai/models/fal-ai/nano-banana-pro | Output count × resolution tier, plus the documented per-request web-search surcharge. |
| GPT Image 2 | https://fal.ai/models/openai/gpt-image-2 | Official size/quality projection; edit projection is only shown for exactly one reference. |
| GPT Image 1.5 | https://fal.ai/models/fal-ai/gpt-image-1.5 | Minimum output-image price; variable text and input-image tokens are explicitly excluded. |
| FLUX Schnell | https://fal.ai/models/fal-ai/flux/schnell | Rounded-up output megapixels × $0.003. |
| FLUX Schnell Redux | https://fal.ai/models/fal-ai/flux/schnell/redux | Rounded-up output megapixels × $0.025. |
| Seedream 5 Pro | https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image | Tentative documented resolution tier; edit adds the documented surcharge for each input after the first. |
| Seedance 2 Fast | https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video | Fixed-duration 720p only: generated seconds × $0.2419. Audio has no surcharge. Auto duration and 480p remain unpriced. |

Every paid request stores the exact endpoint, adapter schema hash, pricing
manifest version, source, audit date, formula, confidence class, billable
configuration and estimated microunits before provider submission. The Rust
boundary rejects oversized, non-fal.ai or endpoint/schema-mismatched snapshots.

## Local actual-history fallback

When no reliable official pre-run number exists, FlowZ may show a separately
labelled local estimate after at least three comparable runs with provider-
reported **actual** cost. Cohorts never mix endpoints, adapter/schema versions,
pricing-manifest versions or billable parameter classes. The displayed value is
the robust median with a P25–P75 range; 1.5-IQR outliers are excluded. Estimated
or unknown costs are never learned. Storage contains only run IDs, bounded
pricing keys, amounts and timestamps—never prompts, URLs or media—and is capped
at 25 samples per cohort and 500 samples globally.
