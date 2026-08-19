"""Entraîne un classifieur léger (Gradient Boosting, scikit-learn) qui décide,
pour une polyligne candidate d'un DXF cadastral, si elle est une vraie limite de
parcelle ou un artefact de tracé (hachure, coche d'annotation, trait parasite).

Objectif : remplacer le seuil fixe `MIN_BOUNDARY_LINE_LENGTH_M = 2m` (bbox
diagonale) de src/lib/parcelle-ingestion.ts par une décision apprise sur
plusieurs signaux à la fois (longueur, nombre de sommets, sinuosité, calque...),
au lieu d'un seul seuil sur un seul signal.

Données d'entrée : CSV produit par scripts/export-line-features.ts, avec une
étiquette FAIBLE (weak label) — "la ligne est-elle tombée près du contour d'une
parcelle finale ?" — pas une vérité terrain annotée à la main. Les métriques
ci-dessous sont donc à interpréter comme une comparaison relative au seuil fixe,
pas comme une précision absolue.

Usage :
    pip install -r ML/requirements.txt
    npx tsx scripts/export-line-features.ts <fichier.dxf> <analysisId>
    python ML/train_line_boundary_classifier.py --csv ML/data/line-features-<analysisId>.csv
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import classification_report, confusion_matrix, roc_auc_score
from sklearn.model_selection import train_test_split

# Seuil actuellement en dur dans parcelle-ingestion.ts (DXF_MIN_BOUNDARY_LINE_LENGTH_M).
CURRENT_FIXED_THRESHOLD_M = 2.0

FEATURE_COLUMNS = [
    "bbox_diagonal_m",
    "total_length_m",
    "num_vertices",
    "num_segments",
    "min_segment_len_m",
    "max_segment_len_m",
    "mean_segment_len_m",
    "straightness",
    "closes_near_start",
]
CATEGORICAL_COLUMN = "layer_class"
LABEL_COLUMN = "label"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", required=True, type=Path, help="CSV produit par scripts/export-line-features.ts")
    p.add_argument("--model-out", type=Path, default=Path("ML/models/line_boundary_gbc.joblib"))
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--random-state", type=int, default=42)
    p.add_argument(
        "--label-tolerance",
        type=float,
        default=None,
        help="Ré-binarise le label depuis dist_to_final_boundary_m avec cette tolérance (m) "
        "au lieu d'utiliser la colonne label déjà calculée par l'export (tolérance figée à l'export).",
    )
    p.add_argument(
        "--n-estimators", type=int, default=150,
        help="Nombre d'arbres. Modèle volontairement 'léger' : peu d'arbres, profondeur faible.",
    )
    p.add_argument("--max-depth", type=int, default=3)
    p.add_argument("--learning-rate", type=float, default=0.1)
    return p.parse_args()


def load_dataset(csv_path: Path, label_tolerance: float | None) -> pd.DataFrame:
    if not csv_path.exists():
        sys.exit(
            f"Introuvable : {csv_path}\n"
            "Génère-le d'abord avec : npx tsx scripts/export-line-features.ts <fichier.dxf> <analysisId>"
        )
    df = pd.read_csv(csv_path)
    missing = [c for c in [*FEATURE_COLUMNS, CATEGORICAL_COLUMN, LABEL_COLUMN] if c not in df.columns]
    if missing:
        sys.exit(f"Colonnes manquantes dans {csv_path} : {missing}")
    if label_tolerance is not None:
        df[LABEL_COLUMN] = (df["dist_to_final_boundary_m"] <= label_tolerance).astype(int)
    return df


def build_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, list[str]]:
    dummies = pd.get_dummies(df[CATEGORICAL_COLUMN], prefix="layer")
    X = pd.concat([df[FEATURE_COLUMNS], dummies], axis=1)
    y = df[LABEL_COLUMN].astype(int)
    return X, y, list(X.columns)


def baseline_fixed_threshold(df: pd.DataFrame) -> dict:
    """Reproduit la règle actuelle (bbox_diagonal_m >= 2m ⇒ conservée) pour comparaison."""
    pred = (df["bbox_diagonal_m"] >= CURRENT_FIXED_THRESHOLD_M).astype(int)
    y = df[LABEL_COLUMN].astype(int)
    report = classification_report(y, pred, target_names=["bruit(0)", "limite(1)"], output_dict=True, zero_division=0)
    return {"report": report, "confusion_matrix": confusion_matrix(y, pred)}


def main() -> None:
    args = parse_args()
    df = load_dataset(args.csv, args.label_tolerance)
    print(f"Lignes chargées : {len(df)} — positifs (label=1) : {df[LABEL_COLUMN].sum()} "
          f"({100 * df[LABEL_COLUMN].mean():.1f}%)")

    X, y, feature_names = build_matrix(df)
    X_train, X_test, y_train, y_test, df_train, df_test = train_test_split(
        X, y, df, test_size=args.test_size, random_state=args.random_state, stratify=y
    )

    print("\n=== Référence : seuil fixe actuel (bbox_diagonal_m >= 2m) sur le jeu de test ===")
    baseline = baseline_fixed_threshold(df_test)
    print(pd.DataFrame(baseline["report"]).T.round(3))
    print("Matrice de confusion [ [VN, FP], [FN, VP] ] :\n", baseline["confusion_matrix"])

    model = GradientBoostingClassifier(
        n_estimators=args.n_estimators,
        max_depth=args.max_depth,
        learning_rate=args.learning_rate,
        random_state=args.random_state,
    )
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_proba = model.predict_proba(X_test)[:, 1]

    print("\n=== Modèle Gradient Boosting sur le jeu de test ===")
    report = classification_report(y_test, y_pred, target_names=["bruit(0)", "limite(1)"], output_dict=True, zero_division=0)
    print(pd.DataFrame(report).T.round(3))
    print("Matrice de confusion [ [VN, FP], [FN, VP] ] :\n", confusion_matrix(y_test, y_pred))
    try:
        print(f"ROC AUC : {roc_auc_score(y_test, y_proba):.3f}")
    except ValueError:
        pass  # une seule classe présente dans y_test

    print("\n=== Importance des features ===")
    importances = pd.Series(model.feature_importances_, index=feature_names).sort_values(ascending=False)
    print(importances.round(4))

    # Le cas qui intéresse vraiment : les lignes que le seuil fixe rejette
    # aujourd'hui (bbox < 2m). Combien sont en réalité de vraies limites (label=1)
    # que le modèle, lui, saurait repêcher ?
    short = df_test[df_test["bbox_diagonal_m"] < CURRENT_FIXED_THRESHOLD_M]
    if len(short) > 0:
        short_X = X_test.loc[short.index]
        short_pred = model.predict(short_X)
        rescued = int(((short["label"] == 1) & (short_pred == 1)).sum())
        true_positives_in_short = int((short["label"] == 1).sum())
        wrongly_kept = int(((short["label"] == 0) & (short_pred == 1)).sum())
        print(f"\n=== Lignes < {CURRENT_FIXED_THRESHOLD_M}m (toutes écartées par le seuil fixe aujourd'hui) ===")
        print(f"Total : {len(short)} | vraies limites parmi elles (label=1) : {true_positives_in_short}")
        print(f"Le modèle en repêcherait correctement : {rescued}/{true_positives_in_short}")
        print(f"Le modèle en garderait à tort (bruit prédit limite) : {wrongly_kept}")

    args.model_out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "feature_names": feature_names}, args.model_out)
    print(f"\nModèle sauvegardé : {args.model_out}")
    print(
        "\nPour l'utiliser en production, il faudrait soit l'exporter (ex. ONNX + onnxruntime-node) "
        "pour l'appeler depuis addOpenLine() dans parcelle-ingestion.ts, soit le servir via un petit "
        "microservice Python. Pas fait ici — cf. discussion avant intégration : le gain doit d'abord "
        "être démontré sur plusieurs fichiers avant d'ajouter cette dépendance au pipeline."
    )


if __name__ == "__main__":
    main()
