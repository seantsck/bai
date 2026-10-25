#!/usr/bin/env bash
# The full parity suite (long: about 40 minutes because the OLD views are slow). Needs the benchmark cluster (serve.mjs) and the datasets
# (build-datasets.mjs, apply-029.mjs, make-reference.mjs). Results: $BAI_BENCH_DIR/results/parity/<tag>/parity.json
set -u
cd "$(dirname "$0")/../../.."
P="node scripts/db/bench/parity.mjs"
$P --old bai_scale_ref --old-schema ref --new bai_scale_opt --tag scale-full-vs-reference --timeout 3000
$P --old bai_base_old --new bai_base_opt --views class_value --per-org --tag base-class-full-direct --timeout 3000
$P --old bai_scale_old --new bai_scale_opt --views class_value --per-org --tag scale-class-full-direct --timeout 3000
$P --old bai_scale_old --new bai_scale_opt --views trade_returns,acquisition_value --sample --tag scale-sample-direct --timeout 3000
$P --old bai_base_old --new bai_base_opt --views trade_returns,acquisition_value --tag base-full-direct --timeout 3000
