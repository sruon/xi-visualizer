#!/usr/bin/env python3
"""Compress pathdata JSON files with gzip for B2 upload."""

import gzip
import shutil
from pathlib import Path

INPUT_DIR = Path(__file__).parent.parent / "public" / "pathdata"
OUTPUT_DIR = Path(__file__).parent.parent / "public" / "pathdata_gz"

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    json_files = list(INPUT_DIR.glob("*.json"))
    print(f"Compressing {len(json_files)} files...")

    total_original = 0
    total_compressed = 0

    for json_file in json_files:
        gz_file = OUTPUT_DIR / f"{json_file.name}.gz"

        with open(json_file, "rb") as f_in:
            original_size = json_file.stat().st_size
            with gzip.open(gz_file, "wb", compresslevel=9) as f_out:
                shutil.copyfileobj(f_in, f_out)

        compressed_size = gz_file.stat().st_size
        total_original += original_size
        total_compressed += compressed_size

        ratio = (1 - compressed_size / original_size) * 100
        print(f"  {json_file.name}: {original_size:,} -> {compressed_size:,} ({ratio:.1f}% reduction)")

    print(f"\nTotal: {total_original:,} -> {total_compressed:,} bytes")
    print(f"Overall reduction: {(1 - total_compressed / total_original) * 100:.1f}%")
    print(f"\nOutput directory: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
