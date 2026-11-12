#!/usr/bin/env python3
"""Prompt 8 - locale checker.

Compares every locales/*.json against the reference (pt-PT.json) and lists
missing, extra and empty keys. Exits with code 1 if any key is missing.

Usage:
    python tools/check_locales.py
"""
import json
import sys
from pathlib import Path

REF = "pt-PT.json"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    locales_dir = Path(__file__).resolve().parent.parent / "frontend" / "locales"
    if not locales_dir.exists():
        print(f"Locales directory not found: {locales_dir}")
        return 1

    ref_path = locales_dir / REF
    if not ref_path.exists():
        print(f"Reference file missing: {ref_path}")
        return 1

    reference = load(ref_path)
    ref_keys = set(reference)
    problems = []
    missing_total = 0

    for path in sorted(locales_dir.glob("*.json")):
        if path.name == REF:
            continue
        data = load(path)
        keys = set(data)
        missing = ref_keys - keys
        extra = keys - ref_keys
        empty = [k for k, v in data.items() if not str(v).strip()]

        print(f"\n{path.name}:")
        if missing:
            print("  MISSING (in reference but not here): " + ", ".join(sorted(missing)))
            missing_total += len(missing)
        else:
            print("  Missing: none")
        if extra:
            print("  EXTRA (not in reference): " + ", ".join(sorted(extra)))
        if empty:
            print("  EMPTY values: " + ", ".join(sorted(empty)))

    if missing_total:
        print(f"\nFAIL: {missing_total} missing key(s) across locales.")
        return 1
    print("\nOK: all locales contain every reference key.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
