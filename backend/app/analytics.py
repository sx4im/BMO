"""Analytics built on top of pandas + matplotlib.

The Flask app uses ``build_summary`` for the JSON report and
``ratings_chart_png`` for the downloadable graph. A CLI is also exposed so
the user can dump CSV + PNG + interactive HTML reports for their write-up.
"""

from __future__ import annotations

import argparse
import io
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless safe — required for the Render gunicorn worker

import matplotlib.pyplot as plt
import pandas as pd

from .store import all_feedback_dataframe_rows


def _to_dataframe(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["user_id", "message_id", "rating", "correctness", "length", "created_at"])
    return pd.DataFrame(rows)


def build_summary(rows: list[dict]) -> dict:
    df = _to_dataframe(rows)
    if df.empty:
        return {
            "total": 0,
            "average_rating": 0,
            "ratings": [],
            "correctness": [],
            "length": [],
        }
    ratings = df["rating"].value_counts().sort_index()
    correctness = df["correctness"].value_counts()
    length = df["length"].value_counts()
    return {
        "total": int(len(df)),
        "average_rating": round(float(df["rating"].mean()), 2),
        "ratings": [{"rating": int(k), "count": int(v)} for k, v in ratings.items()],
        "correctness": [{"label": k, "count": int(v)} for k, v in correctness.items()],
        "length": [{"label": k, "count": int(v)} for k, v in length.items()],
    }


def ratings_chart_png(rows: list[dict]) -> bytes:
    """Render the rating distribution onto the warm cream canvas with coral bars."""
    canvas = "#faf9f5"
    ink = "#141413"
    muted = "#6c6a64"
    hairline = "#e6dfd8"
    coral = "#cc785c"
    coral_edge = "#a9583e"

    df = _to_dataframe(rows)
    fig, ax = plt.subplots(figsize=(7, 4), dpi=140)
    fig.patch.set_facecolor(canvas)
    ax.set_facecolor(canvas)

    if df.empty:
        ax.text(
            0.5, 0.5, "No feedback yet",
            ha="center", va="center",
            color=muted, fontsize=14,
            transform=ax.transAxes,
        )
        ax.axis("off")
    else:
        counts = df["rating"].value_counts().sort_index()
        all_ratings = [1, 2, 3, 4, 5]
        values = [int(counts.get(r, 0)) for r in all_ratings]
        bars = ax.bar(
            [str(r) for r in all_ratings],
            values,
            color=coral,
            edgecolor=coral_edge,
            linewidth=0,
            width=0.65,
        )
        ax.set_title("Feedback rating distribution", color=ink, fontsize=13, pad=14, loc="left")
        ax.set_xlabel("Rating", color=muted, fontsize=11)
        ax.set_ylabel("Count", color=muted, fontsize=11)
        ax.tick_params(colors=muted)
        ax.grid(axis="y", color=hairline, linewidth=1)
        ax.set_axisbelow(True)
        for spine_name, spine in ax.spines.items():
            spine.set_visible(spine_name == "bottom")
            spine.set_color(hairline)
        for bar, value in zip(bars, values):
            if value:
                ax.text(
                    bar.get_x() + bar.get_width() / 2,
                    value,
                    str(value),
                    ha="center", va="bottom",
                    color=ink, fontsize=10,
                )

    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    return buf.getvalue()


def write_full_report(out_dir: Path, user_id: str | None = None) -> None:
    rows = all_feedback_dataframe_rows(user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    df = _to_dataframe(rows)
    df.to_csv(out_dir / "feedback.csv", index=False)

    summary = build_summary(rows)
    pd.DataFrame(summary["ratings"]).to_csv(out_dir / "ratings.csv", index=False)
    pd.DataFrame(summary["correctness"]).to_csv(out_dir / "correctness.csv", index=False)
    pd.DataFrame(summary["length"]).to_csv(out_dir / "length.csv", index=False)

    (out_dir / "rating_distribution.png").write_bytes(ratings_chart_png(rows))

    try:
        import plotly.express as px  # imported lazily — not needed for chart.png

        ratings_df = pd.DataFrame(summary["ratings"]) if summary["ratings"] else pd.DataFrame({"rating": [], "count": []})
        fig = px.bar(ratings_df, x="rating", y="count", title="Rating distribution")
        fig.write_html(out_dir / "rating_distribution.html")
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Bmo feedback analytics from Supabase.")
    parser.add_argument("--out", default="analytics_output")
    parser.add_argument("--user", default=None, help="Limit to a single user id")
    args = parser.parse_args()

    print("Reading feedback from Supabase…")
    write_full_report(Path(args.out), args.user)
    print(f"Reports written to {args.out}")


if __name__ == "__main__":
    main()
