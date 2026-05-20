#!/bin/bash

TARGET="$1"
FILE="$2"

if [ -z "$TARGET" ] || [ -z "$FILE" ]; then
  echo "Usage:"
  echo "./upload_raw.sh \"M 3\" \"/path/to/file.zip\""
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE"
  exit 1
fi

DEST="star_r2:astro-photo/deep-sky/$TARGET/Raw/"

echo "Uploading:"
echo "File: $FILE"
echo "To:   $DEST"

rclone copy "$FILE" "$DEST" --s3-no-check-bucket --progress

echo "Done."