-- transcript_segments -- the normalized (start, end, text) triples.
--
-- THIS TABLE LIVES IN ITS OWN DATABASE FILE.
--
--   data/video_pipeline/transcript_segments.sqlite   (untracked; see .gitignore)
--
-- Why it is separate: it is the largest thing in the pipeline's database by a
-- wide margin -- 698,450 rows for the Sevcik channel, about 98 MB of the
-- 136 MB the catalog file had grown to -- and it is a CACHE. Every row is
-- derived from the transcript JSON under data/video_pipeline/transcripts/,
-- which is tracked, and `tools/fetchSevcikTranscripts.js` rebuilds the table
-- from those files. Keeping the cache in the tracked file made the catalog
-- unpushable: GitHub refuses a file over 100 MB, and the tracked
-- `state.sqlite` had passed it.
--
-- So the CATALOG stays tracked (it is the irreplaceable part -- the video
-- rows took hours of YouTube metadata fetches) and the CACHE does not. The
-- cache is rebuilt from tracked data by `tools/migrateTranscriptSegments.js`
-- and by the extractors, which register the transcripts they find on disk.
--
-- NO FOREIGN KEY HERE, AND THAT IS DELIBERATE. The original table declared
--   transcript_id INTEGER NOT NULL REFERENCES video_transcripts(id)
-- and `video_transcripts` stays in the catalog database. SQLite cannot
-- enforce a foreign key ACROSS databases -- with foreign keys on, an insert
-- into an attached table whose parent lives in the main file fails with
-- "no such table: seg.video_transcripts" -- so the reference could not be
-- kept even if it were written down. `video_transcripts.segment_count`
-- remains the authoritative count, and it is checked against this table's
-- row count by the migration.
--
-- The tools read and write this table through an ATTACH (see
-- `src/transcript/segmentStore.js`), so their SQL is unchanged: an
-- unqualified `transcript_segments` resolves to this file.

CREATE TABLE IF NOT EXISTS transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The row this segment belongs to, in the CATALOG database's
    -- `video_transcripts` table. Not enforced as a foreign key -- see above.
    transcript_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    text TEXT NOT NULL,
    -- Provider confidence for this segment, when the provider reports one.
    confidence REAL,
    UNIQUE(transcript_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_video_time
    ON transcript_segments(video_id, start_sec);
