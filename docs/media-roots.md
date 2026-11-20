# Portable media roots

Default media location is still:

```
<data repo>/data/video_pipeline/{downloads_1080p,downloads_hires,downloads}
```

New downloads are always written to the **primary** dirs (`downloads_1080p` /
`downloads_hires`). Existing files may live in those dirs **and** in extra
search folders at the same time (for example most files on `C:`, a few on
`D:`).

## Option A — config file

Edit `data/video_pipeline/media_roots.json`:

```json
{
  "pipeline_root": null,
  "downloads_1080p": null,
  "downloads_hires": null,
  "downloads": null,
  "extra_dirs": ["D:/data/portfolio_analyzer_revere/videos"]
}
```

- Null primary keys resolve to `<pipeline_root>/<name>` (default:
  `<repo>/data/video_pipeline/<name>`).
- `extra_dirs` (alias `search_dirs`) are **read/search only**. OCR batch tools,
  `findMedia*`, and `findHiresOnDisk` look there after the primary 1080p dir.
- To make **new** downloads land on another drive, set `pipeline_root` or
  `downloads_1080p` to that drive instead of (or in addition to) `extra_dirs`.

Full relocate example:

```json
{
  "pipeline_root": "D:/portfolio_media/video_pipeline",
  "downloads_1080p": null,
  "downloads_hires": null,
  "downloads": null,
  "extra_dirs": []
}
```

## Option B — environment

```
PORTFOLIO_PIPELINE_ROOT=D:\portfolio_media\video_pipeline
PORTFOLIO_DOWNLOADS_1080P=D:\portfolio_media\video_pipeline\downloads_1080p
PORTFOLIO_DOWNLOADS_HIRES=D:\portfolio_media\video_pipeline\downloads_hires
PORTFOLIO_DOWNLOADS=D:\portfolio_media\video_pipeline\downloads
PORTFOLIO_MEDIA_EXTRA_DIRS=D:\data\portfolio_analyzer_revere\videos;E:\more_videos
```

Per-dir env vars override `pipeline_root`. `PORTFOLIO_MEDIA_EXTRA_DIRS` is a
comma- or semicolon-separated list.

## Option C — directory junction

```
mklink /J data\video_pipeline\downloads_1080p D:\portfolio_media\downloads_1080p
```

Legacy tools that still join `data/video_pipeline/...` keep working.

## Split library (C: + D: at once)

Supported patterns:

1. **Catalog absolute path** — `videos.download_path` is
   `D:\...\20230602_30ksgwzWboo.mp4`. `resolveMediaPath` / `findHiresOnDisk` /
   `runAllOcr` / `runQmgOcrBatch` honor it even when the path has no
   `downloads_1080p` substring. A path under `downloads_hires` still means
   “720p only” and does **not** count as already having 1080p.
2. **extra_dirs** — same folder layout (`YYYYMMDD_<videoId>.mp4`) on another
   drive; no catalog edit required if the filename matches.
3. **Primary on D:** — set `pipeline_root` / `downloads_1080p` so new files go
   to D:; leave C: paths in the catalog until files are moved.

## Code entry points

- JS: `src/video/mediaRoots.js`
  (`getMediaRoots`, `getDownloadDir`, `mediaSearchDirs`, `media1080SearchDirs`,
  `findMedia`, `findMediaForDate`, `findMediaForVideoId`, `resolveMediaPath`)
- JS download skip check: `src/video/downloadCandidates.js` → `findHiresOnDisk`
- Python: `tools/media_roots.py` (same contract, including `extra_dirs` and
  `media_1080_search_dirs`)

Catalog `download_path` may be repo-relative or absolute (including another
drive). Downloaders and OCR batch tools resolve through these helpers.
