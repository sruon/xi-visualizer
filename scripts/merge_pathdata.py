#!/usr/bin/env python3
"""
Merge new TurboPathLog data into an existing zone JSON file.
"""

import csv
import json
import sys
from pathlib import Path


def parse_csv(csv_path: Path, swap_yz: bool = False) -> list[dict]:
    points = []
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if swap_yz:
                points.append({
                    "x": float(row["x"]),
                    "y": float(row["z"]),
                    "z": float(row["y"]),
                })
            else:
                points.append({
                    "x": float(row["x"]),
                    "y": float(row["y"]),
                    "z": float(row["z"]),
                })
    return points


def main():
    swap_yz = "--swap-yz" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if len(args) != 2:
        print("Usage: merge_pathdata.py [--swap-yz] <turbopath_dir> <existing_json>")
        sys.exit(1)

    turbopath_dir = Path(args[0])
    json_path = Path(args[1])

    # Load existing data
    with open(json_path, "r") as f:
        data = json.load(f)

    print(f"Loaded {len(data)} existing mobs")

    added = 0
    updated = 0

    # Parse new CSVs
    for mob_dir in turbopath_dir.iterdir():
        if not mob_dir.is_dir():
            continue
        mob_name = mob_dir.name

        for csv_file in mob_dir.glob("*.csv"):
            mob_id = csv_file.stem
            points = parse_csv(csv_file, swap_yz)

            if mob_id in data:
                existing_points = len(data[mob_id]["points"])
                if len(points) > existing_points:
                    data[mob_id]["points"] = points
                    updated += 1
            else:
                data[mob_id] = {"name": mob_name, "points": points}
                added += 1

    # Write merged data
    with open(json_path, "w") as f:
        json.dump(data, f, separators=(",", ":"))

    print(f"Added {added} new mobs, updated {updated} with more points")
    print(f"Total mobs: {len(data)}")


if __name__ == "__main__":
    main()
