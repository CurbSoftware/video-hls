"""PyInstaller entry point for the frozen app.

PyInstaller needs a plain script; src/controlroom/__main__.py can't be one
(its relative imports only resolve under `python -m controlroom`, which is
exactly how dev runs it). This launcher reproduces that: it imports the
package's __main__ and hands it the real argv.
"""

import sys

from controlroom.__main__ import main

sys.exit(main(sys.argv[1:]))
