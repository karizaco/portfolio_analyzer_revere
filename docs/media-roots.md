# Portable media roots

Default media location is still:

```
<data repo>/data/video_pipeline/{downloads_1080p,downloads_hires,downloads}
```

To keep the app on `C:` and store videos on another drive (for example `D:`):

## Option A — config file

Edit `data/video_pipeline/media_roots.json`:

```json
{
  "pipeline_root": "D:/portfolio_media/video_pipeline",
  "downloads_1080p": null,
  "downloads_hires": null,
  "downloads": null
}
```

Null keys resolve to `<pipeline_root>/<name>`.

## Option B — environment

```
PORTFOLIO_PIPELINE_ROOT=D:\portfolio_media\video_pipeline
PORTFOLIO_DOWNLOADS_1080P=D:\portfolio_media\video_pipeline\downloads_1080p
PORTFOLIO_DOWNLOADS_HIRES=D:\portfolio_media\video_pipeline\downloads_hires
PORTFOLIO_DOWNLOADS=D:\portfolio_media\video_pipeline\downloads
```

Per-dir env vars override `pipeline_root`.

## Option C — directory junction

```
mklink /J data\video_pipeline\downloads_1080p D:\portfolio_media\downloads_1080p
```

Legacy tools that still join `data/video_pipeline/...` keep working.

## Code entry points

- JS: `src/video/mediaRoots.js` (`getMediaRoots`, `getDownloadDir`, `findMediaForDate`, `resolveMediaPath`)
- Python: `tools/media_roots.py` (same contract)

Catalog `download_path` may be repo-relative or absolute (including another drive). Downloaders and OCR batch tools resolve through these helpers.
