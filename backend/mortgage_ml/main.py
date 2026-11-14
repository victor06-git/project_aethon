"""Single entry point: EDA -> features -> train -> evaluate.

    python main.py                 # full run (about 30-40 minutes on 2 cores)
    python main.py --fast          # smoke test: 4 Optuna trials per model
    python main.py --stages evaluate
    MTG_DATA_DIR=/path/to/csvs python main.py
"""
from __future__ import annotations

import argparse
import time
import warnings

warnings.filterwarnings("ignore")

STAGES = ["features", "eda", "train", "evaluate"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stages", nargs="+", choices=STAGES, default=STAGES)
    ap.add_argument("--fast", action="store_true", help="few trials / repeats, for a quick end-to-end check")
    args = ap.parse_args()

    from src import config, eda, evaluate, features, train

    config.ensure_dirs()
    t0 = time.perf_counter()
    for stage in STAGES:
        if stage not in args.stages:
            continue
        t = time.perf_counter()
        print(f"\n=== {stage} ===", flush=True)
        if stage == "features":
            features.build_feature_table()
        elif stage == "eda":
            eda.run_eda()
        elif stage == "train":
            train.train_all(fast=args.fast)
        elif stage == "evaluate":
            evaluate.evaluate()
        print(f"--- {stage} done in {time.perf_counter() - t:,.0f}s", flush=True)
    print(f"\nPipeline finished in {(time.perf_counter() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
