#!/usr/bin/env python3
"""
extract-bash-toolcalls.py

Extracts every bash command from opencode agent's bash tool calls
and writes them one per line to a .log file.

The opencode database is read from ~/.local/share/opencode/opencode.db
(part of the opencode storage directory).

Usage:
    ./extract-bash-toolcalls.py [output-path]

    output-path   Optional. Path for the output .log file.
                  Default: bash_toolcalls.log
"""

import sqlite3
import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)  # scripts/
DB_PATH = os.path.expanduser("~/.local/share/opencode/opencode.db")
DEFAULT_OUTPUT = os.path.join(REPO_ROOT, "..", "data", "bash_toolcalls.log")


def main() -> None:
    output_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUTPUT

    # Ensure the output directory exists
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    if not os.path.isfile(DB_PATH):
        print(f"ERROR: opencode database not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()

        # 1. Bash commands from the part table (completed or errored)
        cur.execute("""
            SELECT json_extract(data, '$.state.input.command')
            FROM part
            WHERE json_extract(data, '$.tool') = 'bash'
              AND json_extract(data, '$.state.status') IN ('completed', 'error')
              AND json_extract(data, '$.state.input.command') IS NOT NULL
            ORDER BY time_created;
        """)
        rows = list(cur.fetchall())

        # 2. Also grab any bash commands from events whose parts were compacted
        cur.execute("""
            SELECT DISTINCT json_extract(e.data, '$.part.state.input.command')
            FROM event e
            WHERE json_extract(e.data, '$.part.tool') = 'bash'
              AND json_extract(e.data, '$.part.state.input.command') IS NOT NULL
              AND json_extract(e.data, '$.part.id') NOT IN (SELECT id FROM part)
            ORDER BY 1;
        """)
        rows.extend(cur.fetchall())

        conn.close()

        if not rows:
            print("No bash tool calls found in the database.", file=sys.stderr)
            with open(output_path, "w") as f:
                pass
            sys.exit(0)

        with open(output_path, "w") as f:
            for (cmd,) in rows:
                # Flatten multi-line commands to a single line:
                # replace embedded newlines with literal "\n" so each
                # output line holds exactly one command.
                flat = cmd.replace("\n", "\\n")
                f.write(flat + "\n")

        print(f"Wrote {len(rows)} bash commands to {output_path}")

    except sqlite3.Error as e:
        print(f"ERROR: Database error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
