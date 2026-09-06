# Swamp Archive

`@dieter/archive` is a [Swamp](https://swamp-club.com) model for safely
extracting local `.tar`, `.tar.gz`, `.tgz`, and `.zip` archives.

It extracts all configured source archives into one new destination directory.
The destination must not already exist. Extraction happens in a sibling staging
directory and is published by a final rename only after every archive succeeds.
This avoids treating partial output as complete.

The model rejects unsafe member paths and non-file/non-directory tar members.
ZIP entries are materialized as ordinary files or directories; archive ownership,
modes, and links are never applied. This keeps extracted content usable by the
user running Swamp and avoids importing ownership or executable bits from an
untrusted archive.

## Example

```console
swamp model create @dieter/archive takeout-extract \
  --global-arg 'sourceArchives=["/srv/location-inbox/takeout-001.tgz"]' \
  --global-arg destinationDirectory=/srv/dieter-location/takeout/export-2026-09

swamp model method run takeout-extract extract
```

Archive deletion and read-only filesystem permissions are intentionally outside
this model. They are separate, higher-risk lifecycle operations that should be
performed only after inspecting the extraction summary.

## After extraction

Inspect the summary before acting on the source archives. It records the exact
input paths, target directory, file and directory counts, and uncompressed byte
total. A successful result means the destination was published only after all
archives extracted successfully.

```console
swamp data get takeout-extract extract-summary --json
```

The model never overwrites an existing destination. To repeat an extraction,
choose a new destination or deliberately remove the previous destination after
reviewing it.
