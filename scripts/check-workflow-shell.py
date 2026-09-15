#!/usr/bin/env python3
r"""Parse every `run:` body in .github/workflows/ with `bash -n`.

A workflow's `run:` is just a string as far as YAML is concerned, so a file can
parse cleanly and still hand the runner a script bash refuses. That happened:
a `flock` block was inserted between `for REPO in \` and its list, and the only
signal was a red deploy job on the self-hosted runner — after a full image
build. This runs the same check in seconds, before anything is built.

Deliberately dependency-free. `js-yaml` is present in node_modules but is not a
declared dependency of either repo, so relying on it here would be relying on a
transitive install. Workflow indentation is regular enough to walk directly.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# GitHub substitutes these before the shell ever sees them, so the checker has
# to as well — `${{ env.X }}` is not valid shell.
EXPRESSION = re.compile(r"\$\{\{[^}]*\}\}")
BLOCK_RUN = re.compile(r"^(?P<indent>\s*)-?\s*run:\s*(?P<style>[|>][-+]?)\s*$")
INLINE_RUN = re.compile(r"^(?P<indent>\s*)-?\s*run:\s*(?P<body>\S.*)$")


def blocks(lines: list[str]) -> list[tuple[int, str]]:
    """Yield (line number, script body) for every `run:` in one workflow."""
    found: list[tuple[int, str]] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        block = BLOCK_RUN.match(line)
        if block:
            start = i + 1
            indent = len(block.group("indent"))
            body: list[str] = []
            i += 1
            while i < len(lines):
                current = lines[i]
                if current.strip() and len(current) - len(current.lstrip()) <= indent:
                    break
                body.append(current)
                i += 1
            found.append((start, dedent(body)))
            continue

        inline = INLINE_RUN.match(line)
        if inline:
            found.append((i + 1, inline.group("body")))

        i += 1

    return found


def dedent(body: list[str]) -> str:
    widths = [
        len(line) - len(line.lstrip()) for line in body if line.strip()
    ]
    margin = min(widths) if widths else 0
    return "\n".join(line[margin:] if line.strip() else "" for line in body)


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    workflows = sorted(root.glob(".github/workflows/*.yml")) + sorted(
        root.glob(".github/workflows/*.yaml")
    )

    if not workflows:
        print(f"no workflows under {root}/.github/workflows/", file=sys.stderr)
        return 1

    failures = 0
    for workflow in workflows:
        lines = workflow.read_text(encoding="utf-8").splitlines()
        for line_no, body in blocks(lines):
            script = EXPRESSION.sub("PLACEHOLDER", body)
            result = subprocess.run(
                ["bash", "-n"],
                input=script,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                failures += 1
                print(f"FAIL {workflow}:{line_no}")
                print(f"  {result.stderr.strip()}")

    checked = sum(len(blocks(w.read_text(encoding='utf-8').splitlines())) for w in workflows)
    if failures:
        print(f"\n{failures} of {checked} run: block(s) failed bash -n")
        return 1

    print(f"{checked} run: block(s) in {len(workflows)} workflow(s) pass bash -n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
