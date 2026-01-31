#!/usr/bin/env python3
"""
Parse TurboPathLog CSVs from all captures and generate per-zone JSON files.
For duplicate mob IDs, keeps the one with the most points.
"""

import os
import csv
import json
from pathlib import Path
from collections import defaultdict

ROAM_DIR = Path(r"E:\XI\Roam")
OUTPUT_DIR = Path(r"C:\Users\sruon\Documents\GitHub\xi-visualizer\public\pathdata")


def find_turbopath_dirs(roam_dir: Path):
    """Find all TurboPathLog directories in captures."""
    for capture_dir in roam_dir.iterdir():
        if not capture_dir.is_dir():
            continue
        # Look for TurboPathLog in any subfolder (Ijs, Nouuurs, etc)
        for char_dir in capture_dir.iterdir():
            if not char_dir.is_dir():
                continue
            turbopath = char_dir / "TurboPathLog"
            if turbopath.exists():
                # TurboPathLog has another subfolder with the char name
                for inner_dir in turbopath.iterdir():
                    if inner_dir.is_dir():
                        yield inner_dir


def parse_csv(csv_path: Path) -> list[dict]:
    """Parse a single mob CSV file."""
    points = []
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            points.append({
                "x": float(row["x"]),
                "y": float(row["y"]),
                "z": float(row["z"]),
            })
    return points


def main():
    # Structure: zone_name -> mob_name -> mob_id -> points[]
    zone_data: dict[str, dict[str, dict[str, list]]] = defaultdict(
        lambda: defaultdict(dict)
    )

    # Collect all data
    for turbopath_dir in find_turbopath_dirs(ROAM_DIR):
        print(f"Processing: {turbopath_dir.parent.parent.parent.name}")

        for zone_dir in turbopath_dir.iterdir():
            if not zone_dir.is_dir():
                continue
            zone_name = zone_dir.name

            for mob_dir in zone_dir.iterdir():
                if not mob_dir.is_dir():
                    continue
                mob_name = mob_dir.name

                for csv_file in mob_dir.glob("*.csv"):
                    mob_id = csv_file.stem
                    points = parse_csv(csv_file)

                    # Keep the version with most points
                    existing = zone_data[zone_name][mob_name].get(mob_id)
                    if existing is None or len(points) > len(existing):
                        zone_data[zone_name][mob_name][mob_id] = points

    # Write per-zone JSON files
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for zone_name, mobs in zone_data.items():
        output_file = OUTPUT_DIR / f"{zone_name}.json"

        # Flatten structure for output
        output = {}
        for mob_name, mob_ids in mobs.items():
            for mob_id, points in mob_ids.items():
                output[mob_id] = {
                    "name": mob_name,
                    "points": points,
                }

        with open(output_file, "w") as f:
            json.dump(output, f, separators=(",", ":"))

        print(f"Wrote {output_file.name}: {len(output)} mobs")

    print(f"\nTotal zones: {len(zone_data)}")


if __name__ == "__main__":
    main()
