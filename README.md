# Swamp Archive

`@dieter/archive` is a [Swamp](https://swamp-club.com) model for safely
extracting local `.tar`, `.tar.gz`, `.tgz`, and `.zip` archives.

It extracts all configured source archives into one new destination directory.
The destination must not already exist. Extraction happens in a sibling staging
directory and is published by a final rename only after every archive succeeds.
This avoids treating partial output as complete.

The model rejects unsafe archive paths and links. It preserves neither archive
ownership nor file modes, which keeps extracted content usable by the user
running Swamp and avoids importing ownership or executable bits from an
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
