"""Cherche, pour chaque feature géométrique candidate (longueur de segment,
diagonale de bbox...), le seuil qui approche le mieux le label faible du CSV
d'export — pour comparer une règle déterministe à UNE feature (comme le seuil
actuel `MIN_BOUNDARY_LINE_LENGTH_M`, mais sur un autre signal) au modèle
Gradient Boosting entraîné dans train_line_boundary_classifier.py.

Même split train/test (test_size=0.2, random_state=42, stratify=y) que
train_line_boundary_classifier.py, pour rester directement comparable : le
seuil est choisi sur le train (maximise le F1), évalué sur le test.

Usage :
    python ML/threshold_search.py --csv ML/data/line-features-143.csv
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split

CURRENT_FIXED_THRESHOLD_M = 2.0
CANDIDATE_FEATURES = [
    "bbox_diagonal_m",
    "max_segment_len_m",
    "mean_segment_len_m",
    "total_length_m",
    "min_segment_len_m",
]
LABEL_COLUMN = "label"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", required=True, type=Path)
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--random-state", type=int, default=42)
    return p.parse_args()


def best_threshold(values: pd.Series, y: pd.Series) -> tuple[float, float]:
    """Balaye les valeurs observées comme seuils candidats (>=), retient celui qui maximise le F1."""
    candidates = np.unique(values.values)
    if len(candidates) > 500:
        candidates = np.quantile(candidates, np.linspace(0, 1, 500))
    best_t, best_f1 = candidates[0], -1.0
    for t in candidates:
        pred = (values >= t).astype(int)
        f1 = f1_score(y, pred, zero_division=0)
        if f1 > best_f1:
            best_f1, best_t = f1, t
    return best_t, best_f1


def evaluate(pred: pd.Series, y: pd.Series) -> dict:
    return {
        "accuracy": accuracy_score(y, pred),
        "precision": precision_score(y, pred, zero_division=0),
        "recall": recall_score(y, pred, zero_division=0),
        "f1": f1_score(y, pred, zero_division=0),
        "confusion_matrix": confusion_matrix(y, pred),
    }


def main() -> None:
    args = parse_args()
    df = pd.read_csv(args.csv)
    y = df[LABEL_COLUMN].astype(int)

    df_train, df_test, y_train, y_test = train_test_split(
        df, y, test_size=args.test_size, random_state=args.random_state, stratify=y
    )
    print(f"Train : {len(df_train)} | Test : {len(df_test)} | positifs (test) : {y_test.mean():.1%}\n")

    print(f"=== Référence : seuil fixe actuel sur bbox_diagonal_m >= {CURRENT_FIXED_THRESHOLD_M}m ===")
    baseline_pred = (df_test["bbox_diagonal_m"] >= CURRENT_FIXED_THRESHOLD_M).astype(int)
    b = evaluate(baseline_pred, y_test)
    print(f"accuracy={b['accuracy']:.3f}  precision={b['precision']:.3f}  recall={b['recall']:.3f}  f1={b['f1']:.3f}")
    print("confusion [[VN,FP],[FN,VP]] :\n", b["confusion_matrix"])

    results = []
    for feat in CANDIDATE_FEATURES:
        t, train_f1 = best_threshold(df_train[feat], y_train)
        pred = (df_test[feat] >= t).astype(int)
        m = evaluate(pred, y_test)
        results.append((feat, t, m))
        tag = "  <-- feature actuelle" if feat == "bbox_diagonal_m" else ""
        print(f"\n=== {feat} >= {t:.3f} (seuil choisi sur train, F1 train={train_f1:.3f}){tag} ===")
        print(f"accuracy={m['accuracy']:.3f}  precision={m['precision']:.3f}  recall={m['recall']:.3f}  f1={m['f1']:.3f}")
        print("confusion [[VN,FP],[FN,VP]] :\n", m["confusion_matrix"])

    best_feat, best_t, best_m = max(results, key=lambda r: r[2]["f1"])
    print(f"\n=== Meilleure règle à seuil unique : {best_feat} >= {best_t:.3f} (f1={best_m['f1']:.3f}) ===")
    print(f"vs seuil fixe actuel (bbox_diagonal_m >= {CURRENT_FIXED_THRESHOLD_M}m) : f1={b['f1']:.3f}")

    # Même métrique "sauvetage" que train_line_boundary_classifier.py, pour
    # rester comparable au modèle GBC : parmi les lignes que la règle ACTUELLE
    # écarte (bbox < 2m), combien la nouvelle règle rattraperait correctement ?
    short = df_test[df_test["bbox_diagonal_m"] < CURRENT_FIXED_THRESHOLD_M]
    if len(short) > 0:
        short_pred = (short[best_feat] >= best_t).astype(int)
        rescued = int(((short[LABEL_COLUMN] == 1) & (short_pred == 1)).sum())
        total_positive_in_short = int((short[LABEL_COLUMN] == 1).sum())
        wrongly_kept = int(((short[LABEL_COLUMN] == 0) & (short_pred == 1)).sum())
        print(f"\n=== Lignes < {CURRENT_FIXED_THRESHOLD_M}m (toutes écartées par la règle actuelle) ===")
        print(f"Total : {len(short)} | vraies limites parmi elles (label=1) : {total_positive_in_short}")
        print(f"La règle '{best_feat} >= {best_t:.3f}' en repêcherait correctement : {rescued}/{total_positive_in_short}")
        print(f"...en gardant à tort (bruit) : {wrongly_kept}")


if __name__ == "__main__":
    main()
