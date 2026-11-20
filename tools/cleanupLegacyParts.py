"""Step 1 + 2: salvage legacy .part names, delete dead .part files.

Re-runnable: it re-derives the classification from the filesystem + catalog each
time, so a second run is a no-op rather than a double-rename.
"""
import json, os, re, sqlite3, shutil

D = r"D:\data\portfolio_analyzer_revere\videos"
DB = r"data/video_pipeline/state.sqlite"

c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
cat = {r["video_id"]: dict(r) for r in c.execute(
    "SELECT video_id, upload_date FROM videos WHERE channel='qullamaggie'")}

def vid_of(stem):
    v = re.sub(r"^20\d{6}_", "", stem)
    return re.sub(r"^_", "", v)

existing = set(os.listdir(D))
finals = {}
for f in existing:
    if f.endswith(".mp4"):
        finals[vid_of(f[:-4])] = os.path.join(D, f)

renamed, deleted, skipped = [], [], []
for name in sorted(os.listdir(D)):
    if not name.endswith(".mp4.part"): continue
    stem = name[:-len(".mp4.part")]
    if re.match(r"^20\d{6}_", stem):
        skipped.append((name, "already dated (yt-dlp resumable)")); continue
    vid = vid_of(stem)
    final = finals.get(vid)
    if final and os.path.getsize(final) > 1024*1024:
        size = os.path.getsize(os.path.join(D, name))
        os.remove(os.path.join(D, name))
        deleted.append({"part": name, "mb": round(size/1048576,1), "final": os.path.basename(final)})
        print(f"DELETED {name} ({size/1048576:.1f}MB) -> final {os.path.basename(final)}")
    else:
        row = cat.get(vid)
        if not row or not row["upload_date"]:
            skipped.append((name, "no catalog upload_date")); continue
        target = f"{row['upload_date']}_{vid}.mp4.part"
        if target in existing:
            skipped.append((name, f"target exists: {target}")); continue
        os.rename(os.path.join(D, name), os.path.join(D, target))
        existing.add(target)
        renamed.append({"from": name, "to": target, "mb": round(os.path.getsize(os.path.join(D,target))/1048576,1)})
        print(f"RENAMED {name} -> {target}")

free_before = shutil.disk_usage(D).free
print()
print(f"renamed={len(renamed)} deleted={len(deleted)} skipped={len(skipped)}")
for s in skipped: print("  SKIP", s)
print(f"D: free space now {free_before/2**30:.1f} GB")
json.dump({"renamed": renamed, "deleted": deleted, "skipped": skipped},
          open("data/_part_cleanup_result.json","w"), indent=1)
