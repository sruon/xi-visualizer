#!/usr/bin/env python3
"""
Parse TurboPathLog CSVs into the per-zone roam dataset.

Takes capture directories on the command line; with none it walks every capture under ROAM_DIR.
Writes <Zone>.json.gz, which is what the visualizer serves and what the region bootstrap reads.
For a mob recorded in more than one capture, the longer trail wins.
"""

import csv
import gzip
import json
import sys
from pathlib import Path
from collections import defaultdict

ROAM_DIR = Path(r"E:\XI\Roam")
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "pathdata_gz"


def find_turbopath_dirs(captures):
    """Yields each <capture>/<char>/TurboPathLog/<char> directory, which holds the zone folders."""
    for capture_dir in captures:
        if not capture_dir.is_dir():
            continue

        for char_dir in capture_dir.iterdir():
            if not char_dir.is_dir():
                continue

            turbopath = char_dir / "TurboPathLog"
            if not turbopath.exists():
                continue

            for inner_dir in turbopath.iterdir():
                if inner_dir.is_dir():
                    yield inner_dir


def parse_csv(csv_path: Path) -> list[dict]:
    """One mob's trail. Heading and timestamp are carried through: the timestamp is what separates a
    walk from a respawn downstream, and both are in the published dataset."""
    points = []
    with open(csv_path, "r", newline="") as f:
        for row in csv.DictReader(f):
            points.append({
                "x": float(row["x"]),
                "y": float(row["y"]),
                "z": float(row["z"]),
                "dir": int(row["dir"]),
                "t": int(row["timestamp"]),
            })

    return points


def main():
    captures = [Path(a) for a in sys.argv[1:]] or sorted(p for p in ROAM_DIR.iterdir() if p.is_dir())

    # zone -> mob name -> mob id -> points
    zone_data: dict[str, dict[str, dict[str, list]]] = defaultdict(lambda: defaultdict(dict))

    for turbopath_dir in find_turbopath_dirs(captures):
        print(f"Processing: {turbopath_dir.parent.parent.parent.name}")

        for zone_dir in turbopath_dir.iterdir():
            if not zone_dir.is_dir():
                continue

            for mob_dir in zone_dir.iterdir():
                if not mob_dir.is_dir():
                    continue

                for csv_file in mob_dir.glob("*.csv"):
                    points = parse_csv(csv_file)
                    existing = zone_data[zone_dir.name][mob_dir.name].get(csv_file.stem)
                    if existing is None or len(points) > len(existing):
                        zone_data[zone_dir.name][mob_dir.name][csv_file.stem] = points

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for zone_name, mobs in zone_data.items():
        output = {}
        for mob_name, mob_ids in mobs.items():
            for mob_id, points in mob_ids.items():
                output[mob_id] = {"name": mob_name, "points": points}

        out_file = OUTPUT_DIR / f"{zone_name}.json.gz"
        with gzip.open(out_file, "wt", compresslevel=9, encoding="utf-8") as f:
            json.dump(output, f, separators=(",", ":"))

        total = sum(len(m["points"]) for m in output.values())
        print(f"Wrote {out_file.name}: {len(output)} mobs, {total} points, {out_file.stat().st_size / 1e6:.1f} MB")

    print(f"\nTotal zones: {len(zone_data)}")


if __name__ == "__main__":
    main()
