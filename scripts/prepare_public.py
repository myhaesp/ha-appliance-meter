"""Export committed files to a NEW local repository with no inherited history.

Usage: python scripts/prepare_public.py /path/to/new/directory
Does not add a remote, publish, or alter the source repository.
"""
import io
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).resolve()
if destination.exists():
    raise SystemExit("Destination must not exist; refusing to overwrite files.")
archive = subprocess.check_output(["git", "archive", "--format=tar", "HEAD"], cwd=root)
destination.mkdir(parents=True)
with tarfile.open(fileobj=io.BytesIO(archive)) as contents:
    contents.extractall(destination, filter="data")
subprocess.run(["git", "init", "-b", "main"], cwd=destination, check=True)
subprocess.run(["git", "add", "."], cwd=destination, check=True)
subprocess.run([
    "git", "-c", "user.name=Appliance Meter contributors",
    "-c", "user.email=contributors@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-m",
    "Initial public preparation snapshot",
], cwd=destination, check=True, stdout=subprocess.DEVNULL)
print(f"Prepared local repository: {destination}")
print("No remote configured. Resolve docs/releasing.md decisions before publication.")
