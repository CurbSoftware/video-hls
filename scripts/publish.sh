#!/usr/bin/env bash
# Pack the encoder scripts into one bundle, copy it into the local publish
# directory, and attach it to a GitHub release.
# This repo has no version, so the tag is v0.0.0-<shortsha> of current main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="video-hls"
DEST="/home/user/projects/published/${REPO_NAME}"
GH_REPO="CurbSoftware/${REPO_NAME}"

cd "$ROOT"

short="$(git rev-parse --short HEAD)"
tag="v0.0.0-${short}"
echo "No version in this project. Using tag ${tag} from current main."

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/video-hls"
mkdir -p "$bundle/scripts"
cp -a run.sh .env.example LICENSE README.md "$bundle/"
cp -a scripts/encode-batch.sh "$bundle/scripts/"
chmod +x "$bundle/run.sh" "$bundle/scripts/encode-batch.sh"

archive="$stage/video-hls-${tag}.tar.gz"
tar -C "$stage" -czf "$archive" video-hls

mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$archive" "$DEST/"
artifact="$DEST/$(basename "$archive")"

notes="$(mktemp)"
cat >"$notes" <<EOF
No version is set in this repository. This release is current main, tagged ${tag}.

The archive is the encoder: run.sh, the batch encoder, and the example env file.
EOF

if gh release view "$tag" --repo "$GH_REPO" >/dev/null 2>&1; then
  mapfile -t existing < <(gh release view "$tag" --repo "$GH_REPO" --json assets --jq '.assets[].name')
  name="$(basename "$artifact")"
  for have in "${existing[@]+"${existing[@]}"}"; do
    if [[ "$have" == "$name" ]]; then
      echo "release $tag already has $name"
      rm -f "$notes"
      exit 0
    fi
  done
  gh release upload "$tag" "$artifact" --repo "$GH_REPO"
else
  gh release create "$tag" "$artifact" \
    --repo "$GH_REPO" \
    --target main \
    --title "$tag" \
    --notes-file "$notes"
fi
rm -f "$notes"
