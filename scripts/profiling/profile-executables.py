#!/usr/bin/env python3
"""
profile-executables.py

Reads the bash-toolcalls log (produced by extract-bash-toolcalls.py),
splits compound commands on &&, ||, |, and ; (respecting quotes),
extracts just the executable (first word) from each individual command,
and prints the most frequently called executables.

Usage:
    ./profile-executables.py [log-path] [top-n]

    log-path   Path to the bash_toolcalls.log file.
               Default: <repo-root>/data/bash_toolcalls.log
    top-n      Number of top executables to display (default: 30).
               Can be passed as the sole argument without the log path.
"""

import sys
import os
import re
from collections import Counter

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)  # scripts/
DEFAULT_LOG = os.path.join(REPO_ROOT, "..", "data", "bash_toolcalls.log")


def extract_executable(cmd: str) -> str:
    """Return just the executable (first word) from a command string.

    Skips leading line-continuation backslashes and variable assignments
    (even ``$(...)`` with internal spaces), then returns the first real token.

    Examples::

        head -5                    → head
        /etc/run.sh foo            → /etc/run.sh
        FOO=bar make               → make
        DIR=$(mktemp -d) && chmod  → chmod
        cmd1 | cmd2                → cmd1  then  cmd2  (called per part)
    """
    tokens = _smart_split(cmd)
    for tok in tokens:
        if tok == "\\":
            continue
        # Skip leading variable assignments (e.g. FOO=bar, DIR=$(...))
        if "=" in tok and not tok.startswith("/"):
            continue
        # Skip bare flags (likely a split artifact)
        if tok.startswith("-"):
            continue
        return tok
    return tokens[0] if tokens else cmd


def _smart_split(text: str) -> list[str]:
    """Split *text* on whitespace, but keep ``$(...)`` command
    substitutions together as single tokens."""
    tokens: list[str] = []
    buf: list[str] = []
    paren_depth = 0
    in_single = False
    in_double = False
    i = 0
    n = len(text)

    while i < n:
        c = text[i]

        # Track quotes (so $() inside quotes is ignored)
        if c == "'" and not in_double:
            in_single = not in_single
            buf.append(c)
            i += 1
            continue
        if c == '"' and not in_single:
            in_double = not in_double
            buf.append(c)
            i += 1
            continue

        # Track $(...) nesting
        if c == "(" and i > 0 and text[i - 1] == "$" and not in_single and not in_double:
            paren_depth += 1
            buf.append(c)
            i += 1
            continue
        if c == ")":
            if paren_depth > 0:
                paren_depth -= 1
            buf.append(c)
            i += 1
            continue

        # Whitespace (space, tab, newline) is a token boundary —
        # but not inside $(...) or quotes
        if c in (" ", "\t", "\n") and paren_depth == 0 and not in_single and not in_double:
            token = "".join(buf).strip()
            if token:
                tokens.append(token)
            buf = []
            i += 1
            continue

        buf.append(c)
        i += 1

    token = "".join(buf).strip()
    if token:
        tokens.append(token)

    return tokens


def split_commands(line: str) -> list[str]:
    """Split a bash command line into individual commands at ``&&``, ``||``,
    ``|`` and ``;`` boundaries, respecting single/double quotes and
    backslash escaping.

    Args:
        line: A single bash command (possibly compound).

    Returns:
        A list of individual command strings.
    """
    cmds: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    i = 0
    n = len(line)

    while i < n:
        c = line[i]

        # ----- backslash escape (outside single quotes) -----
        if c == "\\" and not in_single:
            buf.append(c)
            if i + 1 < n:
                i += 1
                buf.append(line[i])
            i += 1
            continue

        # ----- single quote toggle -----
        if c == "'" and not in_double:
            in_single = not in_single
            buf.append(c)
            i += 1
            continue

        # ----- double quote toggle -----
        if c == '"' and not in_single:
            in_double = not in_double
            buf.append(c)
            i += 1
            continue

        # ----- inside quotes — append literally -----
        if in_single or in_double:
            buf.append(c)
            i += 1
            continue

        # ----- outside quotes — check separators -----

        # 1)  &&
        if line[i : i + 2] == "&&":
            cmd = "".join(buf).strip()
            if cmd:
                cmds.append(cmd)
            buf = []
            i += 2
            continue

        # 2)  ||
        if line[i : i + 2] == "||":
            cmd = "".join(buf).strip()
            if cmd:
                cmds.append(cmd)
            buf = []
            i += 2
            continue

        # 3)  ;  (command separator)
        if c == ";":
            cmd = "".join(buf).strip()
            if cmd:
                cmds.append(cmd)
            buf = []
            i += 1
            continue

        # 4)  |  (pipe)  – note: || is already consumed above,
        #     so a bare | here is definitely a pipe.
        if c == "|":
            cmd = "".join(buf).strip()
            if cmd:
                cmds.append(cmd)
            buf = []
            i += 1
            continue

        # ----- ordinary character -----
        buf.append(c)
        i += 1

    # Last command
    cmd = "".join(buf).strip()
    if cmd:
        cmds.append(cmd)

    return cmds


def main() -> None:
    # Positional args: [log-path] [top-n]
    # If only one arg is given and it looks like a number, treat it as top-n.
    log_path = DEFAULT_LOG
    top_n = 30

    if len(sys.argv) > 2:
        log_path = sys.argv[1]
        top_n = int(sys.argv[2])
    elif len(sys.argv) > 1:
        maybe = sys.argv[1]
        if maybe.isdigit():
            top_n = int(maybe)
        else:
            log_path = maybe

    if not os.path.isfile(log_path):
        print(f"ERROR: log file not found at {log_path}", file=sys.stderr)
        print("Run extract-bash-toolcalls.py first to generate it.", file=sys.stderr)
        sys.exit(1)

    counter: Counter[str] = Counter()

    with open(log_path) as f:
        for line_no, raw_line in enumerate(f, 1):
            line = raw_line.strip()
            if not line:
                continue
            # Restore literal \n back to real newlines for correct parsing
            # (the extract script flattens newlines to \n)
            line = line.replace("\\n", "\n")
            parts = split_commands(line)
            executables = [extract_executable(p) for p in parts]
            counter.update(executables)

    if not counter:
        print("No commands found in the log.", file=sys.stderr)
        sys.exit(0)

    total = sum(counter.values())
    most_common = counter.most_common(top_n)

    print(f"{'Count':>8}  {'%':>6}  Executable")
    print(f"{'─'*8}  {'─'*6}  ──────────")
    for cmd, count in most_common:
        pct = 100.0 * count / total
        print(f"{count:>8}  {pct:>5.1f}%  {cmd}")

    print(f"\n{'─'*8}  {'─'*6}  ───────")
    print(f"{total:>8}  {'100%':>6}  Total ({len(counter)} unique executables)")


if __name__ == "__main__":
    main()
